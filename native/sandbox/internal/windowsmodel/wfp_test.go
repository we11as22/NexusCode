package windowsmodel

import "testing"

func TestOfflineWFPIdentityAndFilterSpecsAreStableAndUnique(t *testing.T) {
	if OfflineWFPProviderKey.IsZero() || OfflineWFPSubLayerKey.IsZero() {
		t.Fatal("WFP provider and sublayer keys must be non-zero")
	}
	if OfflineWFPProviderKey == OfflineWFPSubLayerKey {
		t.Fatal("WFP provider and sublayer keys must be distinct")
	}
	if len(OfflineWFPFilterSpecs) != 4 {
		t.Fatalf("got %d offline WFP filters, want 4", len(OfflineWFPFilterSpecs))
	}

	keys := map[GUID]struct{}{}
	names := map[string]struct{}{}
	layers := map[GUID]struct{}{}
	for _, spec := range OfflineWFPFilterSpecs {
		if spec.Key.IsZero() || spec.LayerKey.IsZero() {
			t.Fatalf("filter %q has a zero key", spec.Name)
		}
		if spec.Name == "" || spec.Description == "" {
			t.Fatalf("filter %#v is missing display metadata", spec)
		}
		if _, exists := keys[spec.Key]; exists {
			t.Fatalf("duplicate WFP filter key for %q", spec.Name)
		}
		if _, exists := names[spec.Name]; exists {
			t.Fatalf("duplicate WFP filter name %q", spec.Name)
		}
		if _, exists := layers[spec.LayerKey]; exists {
			t.Fatalf("duplicate WFP layer for %q", spec.Name)
		}
		keys[spec.Key] = struct{}{}
		names[spec.Name] = struct{}{}
		layers[spec.LayerKey] = struct{}{}
	}
}
