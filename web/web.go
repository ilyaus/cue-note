// Package web embeds the cue-note single-page UI assets so the UI binary is
// self-contained.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var assets embed.FS

// Assets returns the UI file system rooted at the static directory.
func Assets() (fs.FS, error) {
	return fs.Sub(assets, "static")
}
