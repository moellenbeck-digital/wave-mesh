package wavemobile

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"time"
)

// iOS ends a packet tunnel extension that grows past roughly 50 MB, and it does
// so without a crash anybody sees: the VPN simply drops. wireguard-go already
// shrinks its queues for iOS, but for one device -- here there is one per wave.
// A soft limit makes the Go collector work harder before the system steps in;
// it is a limit on the heap the runtime manages, not on what the process may
// use, so it is set below the system's line.
const extensionMemoryLimit = 36 << 20

func init() {
	if runtime.GOOS == "ios" {
		debug.SetMemoryLimit(extensionMemoryLimit)
	}
}

// memoryInterval is how often the footprint goes to the log: rarely enough to
// cost nothing, often enough to show a trend before iOS acts on it.
const memoryInterval = 5 * time.Minute

// watchMemory writes what the Go runtime holds to the log until stop closes.
// Whether a second or third wave still fits is a question only a real phone
// answers, and this is how the answer reaches somebody.
func watchMemory(log func(string), stop <-chan struct{}) {
	report := func() {
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		log(fmt.Sprintf("memory: heap %d MB in use, %d MB from the system, %d goroutines",
			stats.HeapInuse>>20, stats.Sys>>20, runtime.NumGoroutine()))
	}
	report()
	ticker := time.NewTicker(memoryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			report()
		case <-stop:
			return
		}
	}
}
