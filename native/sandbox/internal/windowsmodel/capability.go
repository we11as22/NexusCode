package windowsmodel

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type RootCapabilities struct {
	ReadSID  string `json:"readSid"`
	WriteSID string `json:"writeSid,omitempty"`
}

type CapabilityRegistry struct {
	Roots map[string]RootCapabilities `json:"roots"`
}

type CapabilityPlan struct {
	Roots           map[string]RootCapabilities
	RestrictingSIDs []string
}

type SIDGenerator func() (string, error)

func (registry *CapabilityRegistry) BuildPlan(
	readableRoots []string,
	writableRoots []string,
	generate SIDGenerator,
) (CapabilityPlan, bool, error) {
	if generate == nil {
		generate = RandomCapabilitySID
	}
	if registry.Roots == nil {
		registry.Roots = make(map[string]RootCapabilities)
	}
	readKeys, err := canonicalSet(readableRoots)
	if err != nil {
		return CapabilityPlan{}, false, err
	}
	writeKeys, err := canonicalSet(writableRoots)
	if err != nil {
		return CapabilityPlan{}, false, err
	}
	for key := range writeKeys {
		if _, readable := readKeys[key]; !readable {
			return CapabilityPlan{}, false, fmt.Errorf("writable root %q is outside readable authority", key)
		}
	}

	changed := false
	active := make(map[string]RootCapabilities, len(readKeys))
	restricting := make([]string, 0, len(readKeys)+len(writeKeys))
	keys := sortedKeys(readKeys)
	for _, key := range keys {
		caps := registry.Roots[key]
		if caps.ReadSID == "" {
			caps.ReadSID, err = generate()
			if err != nil {
				return CapabilityPlan{}, false, fmt.Errorf("generate read capability for %q: %w", key, err)
			}
			changed = true
		}
		if _, writable := writeKeys[key]; writable && caps.WriteSID == "" {
			caps.WriteSID, err = generate()
			if err != nil {
				return CapabilityPlan{}, false, fmt.Errorf("generate write capability for %q: %w", key, err)
			}
			changed = true
		}
		registry.Roots[key] = caps
		activeCaps := RootCapabilities{ReadSID: caps.ReadSID}
		restricting = append(restricting, caps.ReadSID)
		if _, writable := writeKeys[key]; writable {
			activeCaps.WriteSID = caps.WriteSID
			restricting = append(restricting, caps.WriteSID)
		}
		active[key] = activeCaps
	}
	return CapabilityPlan{Roots: active, RestrictingSIDs: restricting}, changed, nil
}

func RandomCapabilitySID() (string, error) {
	var words [4]uint32
	if err := binary.Read(rand.Reader, binary.LittleEndian, &words); err != nil {
		return "", err
	}
	for index := range words {
		if words[index] == 0 {
			words[index] = uint32(index + 1)
		}
	}
	return fmt.Sprintf(
		"S-1-5-21-%d-%d-%d-%d",
		words[0],
		words[1],
		words[2],
		words[3],
	), nil
}

func CanonicalWindowsPath(candidate string) (string, error) {
	if candidate == "" || strings.IndexByte(candidate, 0) >= 0 {
		return "", errors.New("Windows path must be non-empty and contain no NUL")
	}
	value := strings.ReplaceAll(candidate, "/", `\`)
	var prefix string
	var rest string
	switch {
	case strings.HasPrefix(value, `\\`):
		parts := strings.Split(strings.TrimPrefix(value, `\\`), `\`)
		if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
			return "", fmt.Errorf("UNC path must include server and share: %q", candidate)
		}
		prefix = `\\` + parts[0] + `\` + parts[1]
		rest = strings.Join(parts[2:], `\`)
	case len(value) >= 3 && isASCIIAlpha(value[0]) && value[1] == ':' && value[2] == '\\':
		prefix = value[:3]
		rest = value[3:]
	default:
		return "", fmt.Errorf("path must be absolute with a drive or UNC share: %q", candidate)
	}
	stack := make([]string, 0)
	for _, part := range strings.Split(rest, `\`) {
		switch part {
		case "", ".":
			continue
		case "..":
			if len(stack) == 0 {
				return "", fmt.Errorf("path escapes its Windows root: %q", candidate)
			}
			stack = stack[:len(stack)-1]
		default:
			stack = append(stack, part)
		}
	}
	if len(stack) == 0 {
		return strings.ToLower(strings.TrimSuffix(prefix, `\`)) + `\`, nil
	}
	if strings.HasSuffix(prefix, `\`) {
		return strings.ToLower(prefix + strings.Join(stack, `\`)), nil
	}
	return strings.ToLower(prefix + `\` + strings.Join(stack, `\`)), nil
}

func WindowsPathContains(root string, candidate string) (bool, error) {
	canonicalRoot, err := CanonicalWindowsPath(root)
	if err != nil {
		return false, err
	}
	canonicalCandidate, err := CanonicalWindowsPath(candidate)
	if err != nil {
		return false, err
	}
	if canonicalCandidate == canonicalRoot {
		return true, nil
	}
	return strings.HasPrefix(
		canonicalCandidate,
		strings.TrimSuffix(canonicalRoot, `\`)+`\`,
	), nil
}

func canonicalSet(paths []string) (map[string]struct{}, error) {
	result := make(map[string]struct{}, len(paths))
	for _, candidate := range paths {
		key, err := CanonicalWindowsPath(candidate)
		if err != nil {
			return nil, err
		}
		result[key] = struct{}{}
	}
	return result, nil
}

func sortedKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func isASCIIAlpha(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
}
