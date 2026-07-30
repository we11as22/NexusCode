//go:build windows

package windowsnative

import (
	"testing"
	"unsafe"
)

func TestWFPABIStructSizes(t *testing.T) {
	tests := []struct {
		name string
		got  uintptr
		want uintptr
	}{
		{name: "FWP_BYTE_BLOB", got: unsafe.Sizeof(fwpByteBlob{}), want: 16},
		{name: "FWP_VALUE0", got: unsafe.Sizeof(fwpValue0{}), want: 16},
		{name: "FWP_CONDITION_VALUE0", got: unsafe.Sizeof(fwpConditionValue0{}), want: 16},
		{name: "FWPM_DISPLAY_DATA0", got: unsafe.Sizeof(fwpmDisplayData0{}), want: 16},
		{name: "FWPM_SESSION0", got: unsafe.Sizeof(fwpmSession0{}), want: 72},
		{name: "FWPM_PROVIDER0", got: unsafe.Sizeof(fwpmProvider0{}), want: 64},
		{name: "FWPM_SUBLAYER0", got: unsafe.Sizeof(fwpmSubLayer0{}), want: 72},
		{name: "FWPM_FILTER_CONDITION0", got: unsafe.Sizeof(fwpmFilterCondition0{}), want: 40},
		{name: "FWPM_ACTION0", got: unsafe.Sizeof(fwpmAction0{}), want: 20},
		{name: "FWPM_FILTER0", got: unsafe.Sizeof(fwpmFilter0{}), want: 200},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.got != test.want {
				t.Fatalf("ABI size = %d, want %d", test.got, test.want)
			}
		})
	}
}
