package handlers

import (
	"encoding/json"
	"math"
	"time"

	"license-server/crypto"
	"license-server/db"
	redisclient "license-server/redis"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
)

type ValidateRequest struct {
	Key       string `json:"key"`
	MachineID string `json:"machine_id"`
	Nonce     string `json:"nonce"`
	Timestamp int64  `json:"timestamp"`
}

func Validate(c *fiber.Ctx) error {
	var req ValidateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_request"})
	}
	if req.Key == "" || req.MachineID == "" || req.Nonce == "" {
		return c.Status(400).JSON(fiber.Map{"error": "missing_fields"})
	}

	// 1. Timestamp freshness check (±5 min)
	now := time.Now().Unix()
	if math.Abs(float64(now-req.Timestamp)) > 300 {
		return c.Status(400).JSON(fiber.Map{"error": "stale_timestamp"})
	}

	// 2. Nonce dedup
	if err := redisclient.ConsumeNonce(c.Context(), req.Nonce); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "replayed_nonce"})
	}

	// 3. Machine ban check — CRITICAL: checked before key validation
	banned, err := db.GetBannedMachine(c.Context(), req.MachineID)
	if err == nil && banned != nil {
		// Machine is banned — return special response
		db.InsertAuditLog(c.Context(), "validated_banned", nil, nil, req.MachineID, c.IP(), map[string]any{
			"ban_reason": banned.BanReason,
		})
		return c.Status(403).JSON(fiber.Map{
			"error":      "machine_banned",
			"ban_reason": banned.BanReason,
			"banned_at":  banned.BannedAt,
		})
	}

	// 4. Rate limit per machine
	limited, _ := redisclient.CheckRateLimitMachine(c.Context(), req.MachineID)
	if limited {
		return c.Status(429).JSON(fiber.Map{"error": "rate_limited", "retry_after": 3600})
	}

	// 5. License lookup
	keyHash := db.HashKey(req.Key)
	license, err := db.GetLicenseByKeyHash(c.Context(), keyHash)
	if err == pgx.ErrNoRows || license == nil {
		db.InsertAuditLog(c.Context(), "validated_fail", nil, nil, req.MachineID, c.IP(), map[string]any{"reason": "key_not_found"})
		return c.Status(401).JSON(fiber.Map{"error": "invalid_key"})
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "server_error"})
	}

	// 6. Status + expiry check
	if license.Status == "revoked" {
		return c.Status(401).JSON(fiber.Map{"error": "key_revoked"})
	}
	if time.Now().After(license.ExpiresAt) || license.Status == "expired" {
		return c.Status(401).JSON(fiber.Map{"error": "key_expired"})
	}

	// 7. Machine activation check — auto-activate on first use
	activation, err := db.GetActivation(c.Context(), license.ID, req.MachineID)
	if err == pgx.ErrNoRows {
		// First time this machine uses this key — auto-activate if slots available
		count, _ := db.CountActivations(c.Context(), license.ID)
		if count >= license.MaxDevices {
			return c.Status(403).JSON(fiber.Map{"error": "max_devices_reached"})
		}
		if aerr := db.CreateActivation(c.Context(), license.ID, req.MachineID, "", c.IP()); aerr != nil {
			return c.Status(500).JSON(fiber.Map{"error": "server_error"})
		}
		activation, err = db.GetActivation(c.Context(), license.ID, req.MachineID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "server_error"})
		}
	} else if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "server_error"})
	}
	if activation.IsRevoked {
		return c.Status(403).JSON(fiber.Map{"error": "device_revoked"})
	}

	// 8. Update last_checked
	go db.UpdateLastChecked(c.Context(), activation.ID, c.IP())

	// 9. Build response (without signature)
	licenseTypeStr := []string{"trial", "standard", "premium"}[license.LicenseType]
	response := map[string]any{
		"valid":        true,
		"license_type": licenseTypeStr,
		"expires_at":   license.ExpiresAt.UTC().Format(time.RFC3339),
		"nonce":        req.Nonce,
		"timestamp":    now,
	}

	// 10. Sign response
	payloadBytes, _ := json.Marshal(sortedMap(response))
	response["signature"] = crypto.SignPayload(payloadBytes)

	// 11. Audit log
	licID := license.ID
	actID := activation.ID
	go db.InsertAuditLog(c.Context(), "validated_ok", &licID, &actID, req.MachineID, c.IP(), nil)

	return c.JSON(response)
}

// sortedMap ensures deterministic JSON serialization for signing
func sortedMap(m map[string]any) map[string]any { return m }
