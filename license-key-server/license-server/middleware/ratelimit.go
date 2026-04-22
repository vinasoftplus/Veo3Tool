package middleware

import (
	"context"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	redisclient "license-server/redis"
)

func RateLimitIP(rdb *redis.Client) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limited, err := redisclient.CheckRateLimitIP(c.Context(), c.IP())
		if err != nil {
			return c.Next()
		}
		if limited {
			return c.Status(429).JSON(fiber.Map{"error": "rate_limited", "retry_after": 60})
		}
		return c.Next()
	}
}

// RateLimitLogin: max 10 attempts per IP per 15 minutes for login endpoint
func RateLimitLogin(rdb *redis.Client) fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := fmt.Sprintf("login_limit:%s", c.IP())
		ctx := context.Background()
		count, err := rdb.Incr(ctx, key).Result()
		if err != nil {
			return c.Next()
		}
		if count == 1 {
			rdb.Expire(ctx, key, 15*time.Minute)
		}
		if count > 10 {
			return c.Status(429).JSON(fiber.Map{"error": "too_many_attempts", "retry_after": 900})
		}
		return c.Next()
	}
}
