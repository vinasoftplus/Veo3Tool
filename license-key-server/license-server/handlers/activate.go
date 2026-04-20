package handlers

import (
	"time"

	"license-server/db"
	redisclient "license-server/redis"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
)

type ActivateRequest struct {
	Key         string `json:"key"`
	MachineID   string `json:"machine_id"`
	MachineName string `json:"machine_name"`
	Nonce       string `json:"nonce"`
	Timestamp   int64  `json:"timestamp"`
}

func Activate(c *fiber.Ctx) error {
	var req ActivateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_request"})
	}
	if req.Key == "" || req.MachineID == "" || req.Nonce == "" {
		return c.Status(400).JSON(fiber.Map{"error": "missing_fields"})
	}

	// Nonce dedup
	if err := redisclient.ConsumeNonce(c.Context(), req.Nonce); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "replayed_nonce"})
	}

	// Ban check
	banned, err := db.GetBannedMachine(c.Context(), req.MachineID)
	if err == nil && banned != nil {
		return c.Status(403).JSON(fiber.Map{
			"error":      "machine_banned",
			"ban_reason": banned.BanReason,
		})
	}

	keyHash := db.HashKey(req.Key)
	license, err := db.GetLicenseByKeyHash(c.Context(), keyHash)
	if err == pgx.ErrNoRows || license == nil {
		return c.Status(401).JSON(fiber.Map{"error": "invalid_key"})
	}
	if license.Status != "active" || time.Now().After(license.ExpiresAt) {
		return c.Status(401).JSON(fiber.Map{"error": "key_inactive"})
	}

	// Check existing activation for this machine
	existing, err := db.GetActivation(c.Context(), license.ID, req.MachineID)
	if err == nil && existing != nil {
		if existing.IsRevoked {
			return c.Status(403).JSON(fiber.Map{"error": "device_revoked"})
		}
		// Already activated — return success (idempotent)
		return c.Status(200).JSON(fiber.Map{
			"activated":       true,
			"activated_at":    existing.ActivatedAt,
			"already_existed": true,
		})
	}

	// Check max devices
	count, _ := db.CountActiveActivations(c.Context(), license.ID)
	if count >= int(license.MaxDevices) {
		return c.Status(409).JSON(fiber.Map{"error": "max_devices_reached"})
	}

	if err := db.CreateActivation(c.Context(), license.ID, req.MachineID, req.MachineName, c.IP()); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "activation_failed"})
	}

	licID := license.ID
	go db.InsertAuditLog(c.Context(), "activated", &licID, nil, req.MachineID, c.IP(), nil)

	return c.Status(201).JSON(fiber.Map{
		"activated":    true,
		"activated_at": time.Now().UTC(),
	})
}
