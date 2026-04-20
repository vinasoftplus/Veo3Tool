package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	redisclient "license-server/redis"
)

func RateLimitIP(rdb *redis.Client) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limited, err := redisclient.CheckRateLimitIP(c.Context(), c.IP())
		if err != nil {
			// Redis down — let through but log
			return c.Next()
		}
		if limited {
			return c.Status(429).JSON(fiber.Map{"error": "rate_limited", "retry_after": 60})
		}
		return c.Next()
	}
}
