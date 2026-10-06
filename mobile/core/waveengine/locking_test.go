package waveengine

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A sync.Mutex is not reentrant. Build 4 called hostname() -- which locks
// e.mu -- from inside a region of bringUp that already held it, and every
// approved wave hung its login and every later start. This reads the engine's
// own source: no method that takes e.mu may be called while e.mu is held.
// Crude on purpose (it follows Lock and Unlock line by line), and enough to
// have caught that one.
func TestNoMethodThatLocksIsCalledWhileTheLockIsHeld(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	method := regexp.MustCompile(`^func \(e \*Engine\) (\w+)\(`)
	sources := map[string][]string{}
	locking := map[string]bool{}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(string(raw), "\n")
		sources[file] = lines
		current := ""
		for _, line := range lines {
			if m := method.FindStringSubmatch(line); m != nil {
				current = m[1]
			}
			if current != "" && strings.Contains(line, "e.mu.Lock()") {
				locking[current] = true
			}
		}
	}
	for file, lines := range sources {
		// An Unlock only releases for the code after it when it sits at the
		// depth of its Lock: one inside an early-return branch does not -- the
		// exact shape bringUp had around the call that hung.
		held, lockDepth, depth := false, 0, 0
		for number, line := range lines {
			if strings.HasPrefix(line, "func ") {
				held, depth = false, 0
			}
			if strings.Contains(line, "e.mu.Lock()") {
				held, lockDepth = true, depth
			}
			if strings.Contains(line, "e.mu.Unlock()") && !strings.Contains(line, "defer") && depth == lockDepth {
				held = false
			}
			depth += strings.Count(line, "{") - strings.Count(line, "}")
			if held && depth < lockDepth {
				held = false // left the block the lock was taken in
			}
			if !held {
				continue
			}
			for name := range locking {
				if strings.Contains(line, "e."+name+"(") {
					t.Errorf("%s:%d calls e.%s(), which locks e.mu, while e.mu is held", file, number+1, name)
				}
			}
		}
	}
}
