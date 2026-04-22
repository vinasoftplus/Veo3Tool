package db

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"time"
)

// HashKey returns SHA256 hex of normalized license key
func HashKey(key string) string {
	normalized := strings.ToUpper(strings.ReplaceAll(key, "-", ""))
	h := sha256.Sum256([]byte(normalized))
	return fmt.Sprintf("%x", h)
}

type License struct {
	ID            int64
	KeyHash       string
	LicenseType   int
	CustomerName  string
	CustomerEmail string
	ExpiresAt     time.Time
	MaxDevices    int
	Status        string
	Metadata      []byte
}

type Activation struct {
	ID            int64
	LicenseID     int64
	MachineID     string
	MachineName   string
	ActivatedAt   time.Time
	LastCheckedAt *time.Time
	IPAddress     string
	IsRevoked     bool
}

type BannedMachine struct {
	ID        int64
	MachineID string
	BanReason string
	BannedAt  time.Time
	IsActive  bool
}

func GetLicenseByKeyHash(ctx context.Context, keyHash string) (*License, error) {
	row := pool.QueryRow(ctx, `
		SELECT id, key_hash, license_type, customer_name, customer_email,
		       expires_at, max_devices, status
		FROM licenses
		WHERE key_hash = $1
	`, keyHash)
	var l License
	err := row.Scan(&l.ID, &l.KeyHash, &l.LicenseType, &l.CustomerName,
		&l.CustomerEmail, &l.ExpiresAt, &l.MaxDevices, &l.Status)
	if err != nil {
		return nil, err
	}
	return &l, nil
}

func GetActivation(ctx context.Context, licenseID int64, machineID string) (*Activation, error) {
	row := pool.QueryRow(ctx, `
		SELECT id, license_id, machine_id, machine_name, activated_at,
		       last_checked_at, is_revoked
		FROM activations
		WHERE license_id = $1 AND machine_id = $2
	`, licenseID, machineID)
	var a Activation
	err := row.Scan(&a.ID, &a.LicenseID, &a.MachineID, &a.MachineName,
		&a.ActivatedAt, &a.LastCheckedAt, &a.IsRevoked)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func CountActiveActivations(ctx context.Context, licenseID int64) (int, error) {
	var count int
	err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM activations WHERE license_id = $1 AND is_revoked = FALSE`,
		licenseID).Scan(&count)
	return count, err
}

func UpdateLastChecked(ctx context.Context, activationID int64, ip, machineName string) error {
	_, err := pool.Exec(ctx, `
		UPDATE activations SET last_checked_at = NOW(), ip_address = $2,
		machine_name = CASE WHEN $3 != '' THEN $3 ELSE machine_name END
		WHERE id = $1
	`, activationID, ip, machineName)
	return err
}

func CreateActivation(ctx context.Context, licenseID int64, machineID, machineName, ip string) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO activations (license_id, machine_id, machine_name, ip_address)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (license_id, machine_id) DO NOTHING
	`, licenseID, machineID, machineName, ip)
	return err
}

func CountActivations(ctx context.Context, licenseID int64) (int, error) {
	var count int
	err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM activations WHERE license_id = $1 AND is_revoked = FALSE`, licenseID).Scan(&count)
	return count, err
}

func GetBannedMachine(ctx context.Context, machineID string) (*BannedMachine, error) {
	row := pool.QueryRow(ctx, `
		SELECT id, machine_id, ban_reason, banned_at, is_active
		FROM banned_machines
		WHERE machine_id = $1 AND is_active = TRUE
	`, machineID)
	var b BannedMachine
	err := row.Scan(&b.ID, &b.MachineID, &b.BanReason, &b.BannedAt, &b.IsActive)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func InsertAuditLog(ctx context.Context, eventType string, licenseID *int64, activationID *int64, machineID, ip string, details map[string]any) {
	// best-effort, ignore errors
	pool.Exec(ctx, `
		INSERT INTO audit_log (event_type, license_id, activation_id, machine_id, ip_address, details)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, eventType, licenseID, activationID, machineID, ip, details)
}

// Admin queries

func ListLicensesDB(ctx context.Context, status string, page, limit int) ([]map[string]any, int, error) {
	offset := (page - 1) * limit
	whereClause := "WHERE 1=1"
	args := []any{}
	argIdx := 1
	if status != "" {
		whereClause += fmt.Sprintf(" AND status = $%d", argIdx)
		args = append(args, status)
		argIdx++
	}

	var total int
	countArgs := make([]any, len(args))
	copy(countArgs, args)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM licenses "+whereClause, countArgs...).Scan(&total)

	args = append(args, limit, offset)
	rows, err := pool.Query(ctx, fmt.Sprintf(`
		SELECT id, key_hash, license_type, customer_name, customer_email,
		       created_at, expires_at, max_devices, status
		FROM licenses %s
		ORDER BY created_at DESC
		LIMIT $%d OFFSET $%d
	`, whereClause, argIdx, argIdx+1), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var result []map[string]any
	for rows.Next() {
		var id int64
		var keyHash string
		var licType int
		var custName, custEmail, status string
		var createdAt, expiresAt time.Time
		var maxDevices int
		rows.Scan(&id, &keyHash, &licType, &custName, &custEmail, &createdAt, &expiresAt, &maxDevices, &status)
		machineIDs := getMachineIDsForLicense(ctx, id)
		result = append(result, map[string]any{
			"id":             id,
			"key_hash":       keyHash[:8] + "...",
			"license_type":   licType,
			"customer_name":  custName,
			"customer_email": custEmail,
			"created_at":     createdAt,
			"expires_at":     expiresAt,
			"max_devices":    maxDevices,
			"status":         status,
			"machine_ids":    machineIDs,
		})
	}
	return result, total, nil
}

func getMachineIDsForLicense(ctx context.Context, licenseID int64) []string {
	rows, err := pool.Query(ctx, `SELECT machine_id FROM activations WHERE license_id = $1 AND is_revoked = FALSE`, licenseID)
	if err != nil {
		return []string{}
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var mid string
		rows.Scan(&mid)
		ids = append(ids, mid)
	}
	if ids == nil {
		return []string{}
	}
	return ids
}

func GetStatsDB(ctx context.Context) (map[string]any, error) {
	var totalLicenses, activeLicenses, revokedLicenses, expiredLicenses, expiring30d int64
	var activeActivations, validationsToday, bannedMachines int64
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM licenses").Scan(&totalLicenses)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM licenses WHERE status = 'active'").Scan(&activeLicenses)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM licenses WHERE status = 'revoked'").Scan(&revokedLicenses)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM licenses WHERE expires_at < NOW()").Scan(&expiredLicenses)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM licenses WHERE expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'").Scan(&expiring30d)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM activations WHERE is_revoked = FALSE").Scan(&activeActivations)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM audit_log WHERE event_type = 'validated_ok' AND created_at > NOW() - INTERVAL '1 day'").Scan(&validationsToday)
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM banned_machines WHERE is_active = TRUE").Scan(&bannedMachines)
	return map[string]any{
		"total_licenses":      totalLicenses,
		"active_licenses":     activeLicenses,
		"revoked_licenses":    revokedLicenses,
		"expired_licenses":    expiredLicenses,
		"expiring_30d":        expiring30d,
		"active_activations":  activeActivations,
		"validations_today":   validationsToday,
		"banned_machines":     bannedMachines,
	}, nil
}
