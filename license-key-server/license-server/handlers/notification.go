package handlers

import (
	"context"
	"strconv"
	"time"

	"license-server/db"

	"github.com/gofiber/fiber/v2"
)

// ─── Public ────────────────────────────────────────────────────────────────

// GetNotifications — called by the tool on startup (no auth required).
// Returns active, non-expired notifications ordered by newest first.
func GetNotifications(c *fiber.Ctx) error {
	pool := db.Pool()
	rows, err := pool.Query(context.Background(), `
		SELECT id, title, message, notif_type, title_color, message_color, bg_color, created_at
		FROM notifications
		WHERE is_active = TRUE
		  AND (expires_at IS NULL OR expires_at > NOW())
		ORDER BY created_at DESC
		LIMIT 10
	`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	defer rows.Close()

	var result []map[string]any
	for rows.Next() {
		var id int64
		var title, message, notifType, titleColor, msgColor, bgColor string
		var createdAt time.Time
		if err := rows.Scan(&id, &title, &message, &notifType, &titleColor, &msgColor, &bgColor, &createdAt); err != nil {
			continue
		}
		result = append(result, map[string]any{
			"id":            id,
			"title":         title,
			"message":       message,
			"notif_type":    notifType,
			"title_color":   titleColor,
			"message_color": msgColor,
			"bg_color":      bgColor,
			"created_at":    createdAt,
		})
	}
	if result == nil {
		result = []map[string]any{}
	}
	return c.JSON(fiber.Map{"data": result})
}

// ─── Admin CRUD ─────────────────────────────────────────────────────────────

type CreateNotifRequest struct {
	Title        string  `json:"title"`
	Message      string  `json:"message"`
	NotifType    string  `json:"notif_type"`
	TitleColor   string  `json:"title_color"`
	MessageColor string  `json:"message_color"`
	BgColor      string  `json:"bg_color"`
	ExpiresHours float64 `json:"expires_hours"` // 0 = no expiry
}

func AdminCreateNotification(c *fiber.Ctx) error {
	var req CreateNotifRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_request"})
	}
	if req.Message == "" {
		return c.Status(400).JSON(fiber.Map{"error": "message_required"})
	}

	// Defaults
	if req.NotifType == "" {
		req.NotifType = "info"
	}
	if req.TitleColor == "" {
		req.TitleColor = "#1e293b"
	}
	if req.MessageColor == "" {
		req.MessageColor = "#374151"
	}
	if req.BgColor == "" {
		req.BgColor = "#ffffff"
	}

	adminID := c.Locals("admin_id")

	var expiresAt *time.Time
	if req.ExpiresHours > 0 {
		t := time.Now().Add(time.Duration(req.ExpiresHours * float64(time.Hour)))
		expiresAt = &t
	}

	pool := db.Pool()
	var id int64
	err := pool.QueryRow(context.Background(), `
		INSERT INTO notifications (admin_id, title, message, notif_type, title_color, message_color, bg_color, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id
	`, adminID, req.Title, req.Message, req.NotifType, req.TitleColor, req.MessageColor, req.BgColor, expiresAt).Scan(&id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.Status(201).JSON(fiber.Map{"id": id, "created": true})
}

func AdminListNotifications(c *fiber.Ctx) error {
	pool := db.Pool()
	rows, err := pool.Query(context.Background(), `
		SELECT id, title, message, notif_type, title_color, message_color, bg_color, is_active, created_at, expires_at
		FROM notifications
		ORDER BY created_at DESC
		LIMIT 100
	`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	defer rows.Close()

	var result []map[string]any
	for rows.Next() {
		var id int64
		var title, message, notifType, titleColor, msgColor, bgColor string
		var isActive bool
		var createdAt time.Time
		var expiresAt *time.Time
		if err := rows.Scan(&id, &title, &message, &notifType, &titleColor, &msgColor, &bgColor, &isActive, &createdAt, &expiresAt); err != nil {
			continue
		}
		result = append(result, map[string]any{
			"id":            id,
			"title":         title,
			"message":       message,
			"notif_type":    notifType,
			"title_color":   titleColor,
			"message_color": msgColor,
			"bg_color":      bgColor,
			"is_active":     isActive,
			"created_at":    createdAt,
			"expires_at":    expiresAt,
		})
	}
	if result == nil {
		result = []map[string]any{}
	}
	return c.JSON(fiber.Map{"data": result})
}

func AdminToggleNotification(c *fiber.Ctx) error {
	id, err := strconv.ParseInt(c.Params("id"), 10, 64)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_id"})
	}
	pool := db.Pool()
	var isActive bool
	err = pool.QueryRow(context.Background(),
		"UPDATE notifications SET is_active = NOT is_active WHERE id = $1 RETURNING is_active", id).Scan(&isActive)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{"id": id, "is_active": isActive})
}

func AdminDeleteNotification(c *fiber.Ctx) error {
	id := c.Params("id")
	pool := db.Pool()
	_, err := pool.Exec(context.Background(), "DELETE FROM notifications WHERE id = $1", id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "db_error"})
	}
	return c.JSON(fiber.Map{"deleted": true})
}
