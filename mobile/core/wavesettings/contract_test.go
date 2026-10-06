package wavesettings_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavesettings"
)

var update = flag.Bool("update", false, "rewrite testdata/settings.json from the current shape")

// The settings are the one structure that crosses into Swift and Kotlin, and
// both decode it by hand. Nothing in Go notices when a field changes shape --
// routes became objects with a source address, the platforms went on reading
// strings, and the phones applied no settings at all. So the shape is written
// down here, and the iOS tests decode this very file.
func TestSettingsJSONMatchesTheContractFile(t *testing.T) {
	encoded, err := json.MarshalIndent(wavesettings.Union(twoWaves()), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	path := filepath.Join("testdata", "settings.json")
	if *update {
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, want) {
		t.Fatalf("the settings JSON changed shape; update the Swift and Kotlin readers, then run\n  go test ./wavesettings -run Contract -update\ngot:\n%s", encoded)
	}
}
