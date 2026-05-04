package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"fmt"
	"strconv"
	"strings"
	"time"

	"license-server/config"
	"license-server/db"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v4"
	"github.com/jackc/pgx/v5"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

var cfg *config.Config

func SetConfig(c *config.Config) { cfg = c }

// ─── Auth ──────────────────────────────────────────────────────────

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	TOTPCode string `json:"totp_code"`
}

func AdminLogin(c *fiber.Ctx) error {
	var req LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_request"})
	}

	pool := db.Pool()
	var id int64
	var hash, totpSecret string
	var is2fa bool
	var role string
	err := pool.QueryRow(context.Background(), `
		SELECT id, password_hash, totp_secret, is_2fa_on, role
		FROM admin_users WHERE email = $1
	`, req.Email).Scan(&id, &hash, &totpSecret, &is2fa, &role)
	if err == pgx.ErrNoRows {
		return c.Status(401).JSON(fiber.Map{"error": "invalid_credentials"})
	}

	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		return c.Status(401).JSON(fiber.Map{"error": "invalid_credentials"})
	}

	if is2fa && totpSecret != "" {
		if req.TOTPCode == "" {
			return c.Status(401).JSON(fiber.Map{"error": "totp_required"})
		}
		if !totp.Validate(req.TOTPCode, totpSecret) {
			return c.Status(401).JSON(fiber.Map{"error": "invalid_totp"})
		}
	}

	pool.Exec(context.Background(), "UPDATE admin_users SET last_login_at = NOW() WHERE id = $1", id)

	jwtSecret := cfg.JWTSecret
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":  fmt.Sprintf("%d", id),
		"role": role,
		"exp":  time.Now().Add(8 * time.Hour).Unix(),
	})
	signed, err := token.SignedString([]byte(jwtSecret))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "token_sign_failed"})
	}
	return c.JSON(fiber.Map{"token": signed, "role": role})
}

// ─── Licenses ──────────────────────────────────────────────────────

func ListLicenses(c *fiber.Ctx) error {
	status := c.Query("status", "")
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 200 {
		limit = 50
	}

	licenses, total, err := db.ListLicensesDB(c.Context(), status, page, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{"data": licenses, "total": total, "page": page, "limit": limit})
}

type CreateLicenseRequest struct {
	LicenseType   int    `json:"license_type"`  // 0=trial, 1=standard, 2=premium
	CustomerName  string `json:"customer_name"`
	CustomerEmail string `json:"customer_email"`
	ExpiresDays   int    `json:"expires_days"`
	MaxDevices    int    `json:"max_devices"`
	Count         int    `json:"count"` // bulk: 1-100
}

func CreateLicense(c *fiber.Ctx) error {
	var req CreateLicenseRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_request"})
	}
	if req.ExpiresDays <= 0 {
		req.ExpiresDays = 365
	}
	if req.MaxDevices <= 0 {
		req.MaxDevices = 1
	}
	if req.Count <= 0 {
		req.Count = 1
	}
	if req.Count > 100 {
		req.Count = 100
	}

	expiresAt := time.Now().Add(time.Duration(req.ExpiresDays) * 24 * time.Hour)
	pool := db.Pool()

	var keys []string
	for i := 0; i < req.Count; i++ {
		rawKey := generateKey()
		keyHash := db.HashKey(rawKey)

		_, err := pool.Exec(context.Background(), `
			INSERT INTO licenses (key_hash, license_type, customer_name, customer_email, expires_at, max_devices, status)
			VALUES ($1, $2, $3, $4, $5, $6, 'active')
		`, keyHash, req.LicenseType, req.CustomerName, req.CustomerEmail, expiresAt, req.MaxDevices)
		if err != nil {
			continue
		}
		keys = append(keys, rawKey)
	}

	if len(keys) == 1 {
		return c.Status(201).JSON(fiber.Map{"key": keys[0], "expires_at": expiresAt})
	}
	return c.Status(201).JSON(fiber.Map{"keys": keys, "count": len(keys), "expires_at": expiresAt})
}

func GetLicense(c *fiber.Ctx) error {
	id := c.Params("id")
	pool := db.Pool()
	var l db.License
	var createdAt time.Time
	err := pool.QueryRow(context.Background(), `
		SELECT id, key_hash, license_type, customer_name, customer_email,
		       created_at, expires_at, max_devices, status
		FROM licenses WHERE id = $1
	`, id).Scan(&l.ID, &l.KeyHash, &l.LicenseType, &l.CustomerName, &l.CustomerEmail,
		&createdAt, &l.ExpiresAt, &l.MaxDevices, &l.Status)
	if err == pgx.ErrNoRows {
		return c.Status(404).JSON(fiber.Map{"error": "not_found"})
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{
		"id":             l.ID,
		"key_hash":       l.KeyHash[:8] + "...",
		"license_type":   l.LicenseType,
		"customer_name":  l.CustomerName,
		"customer_email": l.CustomerEmail,
		"created_at":     createdAt,
		"expires_at":     l.ExpiresAt,
		"max_devices":    l.MaxDevices,
		"status":         l.Status,
	})
}

func RevokeLicense(c *fiber.Ctx) error {
	id := c.Params("id")
	pool := db.Pool()
	_, err := pool.Exec(context.Background(),
		"UPDATE licenses SET status = 'revoked' WHERE id = $1", id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{"revoked": true})
}

type UpdateMaxDevicesRequest struct {
	MaxDevices int `json:"max_devices"`
}

func UpdateMaxDevices(c *fiber.Ctx) error {
	id := c.Params("id")
	var req UpdateMaxDevicesRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_request"})
	}
	if req.MaxDevices < 1 || req.MaxDevices > 100 {
		return c.Status(400).JSON(fiber.Map{"error": "max_devices must be 1-100"})
	}
	pool := db.Pool()
	_, err := pool.Exec(context.Background(),
		"UPDATE licenses SET max_devices = $1 WHERE id = $2", req.MaxDevices, id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{"updated": true, "max_devices": req.MaxDevices})
}

// ─── Activations ───────────────────────────────────────────────────

func ListActivations(c *fiber.Ctx) error {
	licenseID := c.Query("license_id", "")
	pool := db.Pool()

	query := `SELECT id, license_id, machine_id, machine_name, activated_at, last_checked_at, ip_address::text, is_revoked
	          FROM activations WHERE 1=1`
	args := []any{}
	if licenseID != "" {
		query += fmt.Sprintf(" AND license_id = $%d", len(args)+1)
		args = append(args, licenseID)
	}
	query += " ORDER BY activated_at DESC LIMIT 200"

	rows, err := pool.Query(context.Background(), query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	defer rows.Close()

	var result []map[string]any
	for rows.Next() {
		var id, licID int64
		var machineID, machineName string
		var activatedAt time.Time
		var lastChecked *time.Time
		var isRevoked bool
		var ip *string
		rows.Scan(&id, &licID, &machineID, &machineName, &activatedAt, &lastChecked, &ip, &isRevoked)
		ipStr := ""
		if ip != nil {
			ipStr = *ip
		}
		result = append(result, map[string]any{
			"id": id, "license_id": licID,
			"machine_id": machineID, "machine_name": machineName,
			"activated_at": activatedAt, "last_checked_at": lastChecked,
			"ip_address": ipStr, "is_revoked": isRevoked,
		})
	}
	return c.JSON(fiber.Map{"data": result})
}

func RevokeActivation(c *fiber.Ctx) error {
	id := c.Params("id")
	pool := db.Pool()
	ctx := context.Background()

	// Get license_id before revoking
	var licenseID int64
	pool.QueryRow(ctx, "SELECT license_id FROM activations WHERE id = $1", id).Scan(&licenseID)

	_, err := pool.Exec(ctx, "UPDATE activations SET is_revoked = TRUE WHERE id = $1", id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}

	// Auto-revoke the linked license
	if licenseID > 0 {
		pool.Exec(ctx, "UPDATE licenses SET status = 'revoked' WHERE id = $1", licenseID)
	}

	return c.JSON(fiber.Map{"revoked": true})
}

// ─── Stats ─────────────────────────────────────────────────────────

func GetStats(c *fiber.Ctx) error {
	stats, err := db.GetStatsDB(c.Context())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(stats)
}

// ─── Ban Management ────────────────────────────────────────────────

type BanRequest struct {
	MachineID string `json:"machine_id"`
	BanReason string `json:"ban_reason"`
}

func ListBans(c *fiber.Ctx) error {
	pool := db.Pool()
	rows, err := pool.Query(context.Background(), `
		SELECT id, machine_id, ban_reason, banned_at, is_active
		FROM banned_machines ORDER BY banned_at DESC LIMIT 200
	`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	defer rows.Close()

	var result []map[string]any
	for rows.Next() {
		var id int64
		var machineID, banReason string
		var bannedAt time.Time
		var isActive bool
		rows.Scan(&id, &machineID, &banReason, &bannedAt, &isActive)
		result = append(result, map[string]any{
			"id": id, "machine_id": machineID,
			"ban_reason": banReason, "banned_at": bannedAt, "is_active": isActive,
		})
	}
	return c.JSON(fiber.Map{"data": result})
}

func BanMachine(c *fiber.Ctx) error {
	var req BanRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_request"})
	}
	if req.MachineID == "" {
		return c.Status(400).JSON(fiber.Map{"error": "machine_id_required"})
	}
	if req.BanReason == "" {
		req.BanReason = "Bị cấm bởi quản trị viên"
	}

	pool := db.Pool()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO banned_machines (machine_id, ban_reason, is_active)
		VALUES ($1, $2, TRUE)
		ON CONFLICT (machine_id) DO UPDATE SET ban_reason = $2, is_active = TRUE, banned_at = NOW()
	`, req.MachineID, req.BanReason)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}

	// Revoke all activations for this machine and their linked licenses
	rows, _ := pool.Query(ctx,
		"UPDATE activations SET is_revoked = TRUE WHERE machine_id = $1 AND is_revoked = FALSE RETURNING license_id",
		req.MachineID)
	var licenseIDs []int64
	for rows.Next() {
		var lid int64
		rows.Scan(&lid)
		licenseIDs = append(licenseIDs, lid)
	}
	rows.Close()
	for _, lid := range licenseIDs {
		pool.Exec(ctx, "UPDATE licenses SET status = 'revoked' WHERE id = $1", lid)
	}

	db.InsertAuditLog(c.Context(), "machine_banned", nil, nil, req.MachineID, c.IP(), map[string]any{
		"reason": req.BanReason,
	})
	return c.Status(201).JSON(fiber.Map{"banned": true, "machine_id": req.MachineID})
}

func DeleteLicense(c *fiber.Ctx) error {
	id := c.Params("id")
	pool := db.Pool()
	ctx := context.Background()

	// Chỉ cho xóa key đã revoked
	var status string
	err := pool.QueryRow(ctx, "SELECT status FROM licenses WHERE id = $1", id).Scan(&status)
	if err == pgx.ErrNoRows {
		return c.Status(404).JSON(fiber.Map{"error": "not_found"})
	}
	isExpired := false
	var expiresAt time.Time
	pool.QueryRow(ctx, "SELECT expires_at FROM licenses WHERE id = $1", id).Scan(&expiresAt)
	if status == "active" && expiresAt.Before(time.Now()) {
		isExpired = true
	}
	if status != "revoked" && !isExpired {
		return c.Status(400).JSON(fiber.Map{"error": "only_revoked_or_expired_can_be_deleted"})
	}

	// Xóa theo đúng thứ tự foreign key: audit_log → activations → licenses
	pool.Exec(ctx, "DELETE FROM audit_log WHERE activation_id IN (SELECT id FROM activations WHERE license_id = $1)", id)
	pool.Exec(ctx, "DELETE FROM audit_log WHERE license_id = $1", id)
	pool.Exec(ctx, "DELETE FROM activations WHERE license_id = $1", id)

	_, err = pool.Exec(ctx, "DELETE FROM licenses WHERE id = $1", id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{"deleted": true})
}

func UnbanMachine(c *fiber.Ctx) error {
	id := c.Params("id")
	pool := db.Pool()
	_, err := pool.Exec(context.Background(),
		"UPDATE banned_machines SET is_active = FALSE WHERE id = $1", id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{"unbanned": true})
}

// ─── Key generation ────────────────────────────────────────────────

// generateKey creates XXXX-XXXX-XXXX-XXXX format key using Base32
func generateKey() string {
	b := make([]byte, 10)
	rand.Read(b)
	// Add checksum byte
	h := sha256.Sum256(b)
	b = append(b, h[0], h[1])
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)
	encoded = strings.ToUpper(encoded)
	// Take first 16 chars and format as XXXX-XXXX-XXXX-XXXX
	if len(encoded) < 16 {
		encoded = encoded + strings.Repeat("A", 16-len(encoded))
	}
	return fmt.Sprintf("%s-%s-%s-%s",
		encoded[0:4], encoded[4:8], encoded[8:12], encoded[12:16])
}
