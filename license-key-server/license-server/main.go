package main

import (
	"log"

	"license-server/config"
	"license-server/crypto"
	"license-server/db"
	"license-server/handlers"
	"license-server/middleware"
	redisclient "license-server/redis"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

func main() {
	cfg := config.Load()

	if err := db.Init(cfg.DatabaseURL); err != nil {
		log.Fatalf("DB init failed: %v", err)
	}
	defer db.Close()

	if err := redisclient.Init(cfg.RedisURL); err != nil {
		log.Fatalf("Redis init failed: %v", err)
	}
	defer redisclient.Close()

	if err := crypto.Init(cfg.Ed25519PrivateKeyB64); err != nil {
		log.Fatalf("Crypto init failed: %v", err)
	}

	handlers.SetConfig(cfg)

	app := fiber.New(fiber.Config{
		BodyLimit:   300 * 1024 * 1024, // 300MB cho upload EXE
		ProxyHeader: "X-Forwarded-For",
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		},
	})

	app.Use(recover.New())
	app.Use(logger.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins: cfg.AdminOrigin,
		AllowHeaders: "Origin,Content-Type,Authorization",
		AllowMethods: "GET,POST,PATCH,DELETE",
	}))

	// Health check
	app.Get("/health", func(c *fiber.Ctx) error {
		dbOk := db.Ping() == nil
		redisOk := redisclient.Ping(c.Context()) == nil
		status := "ok"
		if !dbOk || !redisOk {
			status = "degraded"
		}
		return c.JSON(fiber.Map{"status": status, "db": dbOk, "redis": redisOk})
	})

	// Public tool endpoints
	api := app.Group("/api/v1")
	api.Use(middleware.RateLimitIP(redisclient.Client()))
	api.Post("/validate", handlers.Validate)
	api.Post("/activate", handlers.Activate)
	api.Get("/version", handlers.GetVersion)
	api.Get("/notifications", handlers.GetNotifications)

	// Admin endpoints (JWT protected)
	admin := app.Group("/admin")
	admin.Post("/auth/login", middleware.RateLimitLogin(redisclient.Client()), handlers.AdminLogin)

	adminAuth := admin.Group("", middleware.JWTAuth(cfg.JWTSecret))
	adminAuth.Get("/licenses", handlers.ListLicenses)
	adminAuth.Post("/licenses", handlers.CreateLicense)
	adminAuth.Get("/licenses/:id", handlers.GetLicense)
	adminAuth.Patch("/licenses/:id/revoke", handlers.RevokeLicense)
	adminAuth.Patch("/licenses/:id/max-devices", handlers.UpdateMaxDevices)
	adminAuth.Delete("/licenses/:id", handlers.DeleteLicense)
	adminAuth.Get("/activations", handlers.ListActivations)
	adminAuth.Post("/activations/:id/revoke", handlers.RevokeActivation)
	adminAuth.Get("/stats", handlers.GetStats)
	// Ban management
	adminAuth.Get("/bans", handlers.ListBans)
	adminAuth.Post("/bans", handlers.BanMachine)
	adminAuth.Delete("/bans/:id", handlers.UnbanMachine)
	// Update management
	adminAuth.Get("/update", handlers.GetUpdateInfo)
	adminAuth.Post("/update/upload", handlers.UploadUpdate)
	adminAuth.Patch("/update/required", handlers.SetUpdateRequired)
	// Notification management
	adminAuth.Get("/notifications", handlers.AdminListNotifications)
	adminAuth.Post("/notifications", handlers.AdminCreateNotification)
	adminAuth.Patch("/notifications/:id/toggle", handlers.AdminToggleNotification)
	adminAuth.Delete("/notifications/:id", handlers.AdminDeleteNotification)

	log.Printf("License server starting on :%s", cfg.Port)
	log.Fatal(app.Listen(":" + cfg.Port))
}
