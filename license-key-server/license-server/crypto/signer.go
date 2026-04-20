package crypto

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
)

var privateKey ed25519.PrivateKey
var PublicKeyPEM []byte

func Init(privateKeyB64 string) error {
	pemData, err := base64.StdEncoding.DecodeString(privateKeyB64)
	if err != nil {
		return fmt.Errorf("decode private key base64: %w", err)
	}
	block, _ := pem.Decode(pemData)
	if block == nil {
		return errors.New("failed to decode PEM block from private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("parse private key: %w", err)
	}
	ed, ok := key.(ed25519.PrivateKey)
	if !ok {
		return errors.New("key is not Ed25519")
	}
	privateKey = ed

	// Extract public key PEM for clients
	pubKey := ed.Public().(ed25519.PublicKey)
	pubDER, _ := x509.MarshalPKIXPublicKey(pubKey)
	PublicKeyPEM = pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})
	return nil
}

// SignPayload signs SHA256(payload) with Ed25519 private key, returns base64
func SignPayload(payload []byte) string {
	hash := sha256.Sum256(payload)
	sig := ed25519.Sign(privateKey, hash[:])
	return base64.StdEncoding.EncodeToString(sig)
}
