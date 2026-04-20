package config

import (
	"log"
	"os"
)

type Config struct {
	DatabaseURL          string
	RedisURL             string
	Ed25519PrivateKeyB64 string
	JWTSecret            string
	TOTPEncryptKey       string
	Port                 string
	AdminOrigin          string
}

func Load() *Config {
	cfg := &Config{
		DatabaseURL:          getEnv("DATABASE_URL", "postgres://licenseuser:changeme@localhost:5432/licenses?sslmode=disable"),
		RedisURL:             getEnv("REDIS_URL", "redis://localhost:6379"),
		Ed25519PrivateKeyB64: mustEnv("ED25519_PRIVATE_KEY_B64"),
		JWTSecret:            mustEnv("JWT_SECRET"),
		TOTPEncryptKey:       getEnv("TOTP_ENCRYPT_KEY", ""),
		Port:                 getEnv("PORT", "8080"),
		AdminOrigin:          getEnv("ADMIN_ORIGIN", "*"),
	}
	return cfg
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("Required environment variable %s is not set", key)
	}
	return v
}
