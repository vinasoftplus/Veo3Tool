package handlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/gofiber/fiber/v2"
)

const downloadsDir = "/srv/downloads"
const versionFile = "/srv/downloads/version.json"

type VersionInfo struct {
	Version     string `json:"version"`
	DownloadURL string `json:"download_url"`
	Changelog   string `json:"changelog"`
	Required    bool   `json:"required"`
	ReleasedAt  string `json:"released_at"`
}

// GET /api/v1/version — public, tool gọi khi khởi động
func GetVersion(c *fiber.Ctx) error {
	data, err := os.ReadFile(versionFile)
	if err != nil {
		return c.JSON(fiber.Map{"version": "", "download_url": "", "changelog": "", "required": false})
	}
	var info VersionInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "version_file_corrupt"})
	}
	return c.JSON(info)
}

// GET /admin/update — lấy version info hiện tại cho dashboard
func GetUpdateInfo(c *fiber.Ctx) error {
	data, err := os.ReadFile(versionFile)
	if err != nil {
		return c.JSON(fiber.Map{"ok": true, "version": nil})
	}
	var info VersionInfo
	json.Unmarshal(data, &info)
	return c.JSON(fiber.Map{"ok": true, "version": info})
}

// POST /admin/update/upload — upload EXE + lưu version info
func UploadUpdate(c *fiber.Ctx) error {
	version := c.FormValue("version")
	changelog := c.FormValue("changelog")
	required := c.FormValue("required") == "true"
	domain := c.FormValue("domain") // domain để build download_url

	if version == "" {
		return c.Status(400).JSON(fiber.Map{"error": "version_required"})
	}

	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "file_required"})
	}

	// Đảm bảo thư mục tồn tại
	if err := os.MkdirAll(downloadsDir, 0755); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "cannot_create_dir"})
	}

	// Lưu EXE với tên cố định
	destPath := filepath.Join(downloadsDir, "DreamForge-latest.exe")
	if err := c.SaveFile(file, destPath); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "save_failed"})
	}

	// Build download URL
	downloadURL := "https://" + domain + "/downloads/DreamForge-latest.exe"

	// Lưu version.json
	info := VersionInfo{
		Version:     version,
		DownloadURL: downloadURL,
		Changelog:   changelog,
		Required:    required,
		ReleasedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	data, _ := json.MarshalIndent(info, "", "  ")
	if err := os.WriteFile(versionFile, data, 0644); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "version_save_failed"})
	}

	return c.JSON(fiber.Map{"ok": true, "version": info})
}
