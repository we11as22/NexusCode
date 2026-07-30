//go:build windows

package windowsnative

import "testing"

func TestEnvironmentBlockIsSortedAndDoubleNULTerminated(t *testing.T) {
	block, err := environmentBlock([]string{"z=last", "A=first"})
	if err != nil {
		t.Fatal(err)
	}
	if len(block) < 2 || block[len(block)-1] != 0 || block[len(block)-2] != 0 {
		t.Fatalf("environment block is not double-NUL terminated: %#v", block)
	}
	first := string(runesBeforeNUL(block))
	if first != "A=first" {
		t.Fatalf("environment block is not case-insensitively sorted: %q", first)
	}
}

func TestEmptyEnvironmentBlockContainsTwoNULCodeUnits(t *testing.T) {
	block, err := environmentBlock(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(block) != 2 || block[0] != 0 || block[1] != 0 {
		t.Fatalf("empty environment block = %#v, want two NULs", block)
	}
}

func runesBeforeNUL(block []uint16) []rune {
	result := make([]rune, 0, len(block))
	for _, value := range block {
		if value == 0 {
			break
		}
		result = append(result, rune(value))
	}
	return result
}
