package handlers

import (
	"net"
	"strings"

	"github.com/gofiber/fiber/v2"
)

func clientIP(c *fiber.Ctx) string {
	raw := strings.TrimSpace(c.IP())
	if raw == "" {
		return ""
	}

	// If a proxy accidentally forwards a comma-separated chain, keep the first hop only.
	if strings.Contains(raw, ",") {
		raw = strings.TrimSpace(strings.Split(raw, ",")[0])
	}

	if host, _, err := net.SplitHostPort(raw); err == nil {
		return strings.Trim(host, "[]")
	}

	return strings.Trim(raw, "[]")
}
