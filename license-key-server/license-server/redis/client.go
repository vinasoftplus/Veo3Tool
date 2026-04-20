package redis

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

var ErrNonceReused = errors.New("nonce already used")

func Init(url string) error {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return err
	}
	rdb = redis.NewClient(opts)
	return rdb.Ping(context.Background()).Err()
}

func Client() *redis.Client { return rdb }

func Close() {
	if rdb != nil {
		rdb.Close()
	}
}

func Ping(ctx context.Context) error {
	return rdb.Ping(ctx).Err()
}

// ConsumeNonce atomically marks nonce as used (10min TTL). Returns ErrNonceReused if already seen.
func ConsumeNonce(ctx context.Context, nonce string) error {
	ok, err := rdb.SetNX(ctx, "nonce:"+nonce, 1, 10*time.Minute).Result()
	if err != nil {
		return err
	}
	if !ok {
		return ErrNonceReused
	}
	return nil
}

// RateLimitIP: 100 req/min per IP
func CheckRateLimitIP(ctx context.Context, ip string) (bool, error) {
	key := "rl:ip:" + ip
	count, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return false, err
	}
	if count == 1 {
		rdb.Expire(ctx, key, time.Minute)
	}
	return count > 100, nil
}

// RateLimitMachine: 50 req/day per machine
func CheckRateLimitMachine(ctx context.Context, machineID string) (bool, error) {
	key := "rl:machine:" + machineID
	count, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return false, err
	}
	if count == 1 {
		rdb.Expire(ctx, key, 24*time.Hour)
	}
	return count > 50, nil
}
