package platform

import "github.com/we11as22/NexusCode/native/sandbox/internal/runner"

type Command struct {
	Program string
	Args    []string
	Sandbox string
	Start   runner.StartFunc
}
