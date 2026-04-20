package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

var pool *pgxpool.Pool

func Init(dsn string) error {
	var err error
	pool, err = pgxpool.New(context.Background(), dsn)
	if err != nil {
		return fmt.Errorf("create pool: %w", err)
	}
	return pool.Ping(context.Background())
}

func Pool() *pgxpool.Pool { return pool }

func Ping() error {
	return pool.Ping(context.Background())
}

func Close() {
	if pool != nil {
		pool.Close()
	}
}
