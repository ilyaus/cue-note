// Command server runs the cue-note HTTP API on a local interface.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ilyaus/cue-note/internal/api"
	"github.com/ilyaus/cue-note/internal/config"
	"github.com/ilyaus/cue-note/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "cue-note: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		configPath  = flag.String("config", "", "path to a JSON config file (optional; environment always wins)")
		addr        = flag.String("addr", "", "listen address (default "+config.DefaultAddr+")")
		dataFile    = flag.String("data-file", "", "path to the JSON data file (default "+config.DefaultDataFile+")")
		disableAuth = flag.Bool("disable-auth", false, "serve without API-key authentication (local development only)")
	)
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	if *addr != "" {
		cfg.Addr = *addr
	}
	if *dataFile != "" {
		cfg.DataFile = *dataFile
	}
	if cfg.APIKey == "" && !*disableAuth {
		return fmt.Errorf("no API key configured: set %s (or apiKey in the config file), or pass --disable-auth", config.EnvAPIKey)
	}

	logger := log.New(os.Stderr, "", log.LstdFlags|log.LUTC)

	repo, err := store.OpenJSONFile(cfg.DataFile)
	if err != nil {
		return err
	}

	server, err := api.New(api.Config{
		Repo:        repo,
		APIKey:      cfg.APIKey,
		DisableAuth: *disableAuth,
		Logger:      logger,
	})
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          logger,
	}

	if !config.IsLoopback(cfg.Addr) {
		logger.Printf("cue-note: WARNING listening on non-loopback address %s; the API is reachable from other hosts", cfg.Addr)
	}
	if *disableAuth {
		logger.Printf("cue-note: WARNING authentication is disabled")
	}
	logger.Printf("cue-note: api listening on http://%s (data file %s)", cfg.Addr, repo.Path())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("serve on %s: %w", cfg.Addr, err)
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Printf("cue-note: shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		return <-errCh
	}
}
