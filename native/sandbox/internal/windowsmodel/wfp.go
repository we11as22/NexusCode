package windowsmodel

// GUID matches the Win32 GUID ABI on every Nexus-supported Windows
// architecture. It lives in the platform-neutral model so stable WFP object
// identities and filter coverage can be unit-tested on non-Windows hosts.
type GUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

func (value GUID) IsZero() bool {
	return value == GUID{}
}

var (
	OfflineWFPProviderKey = GUID{
		Data1: 0xb8a48c50, Data2: 0xff36, Data3: 0x4509,
		Data4: [8]byte{0x80, 0x06, 0x7c, 0x4c, 0x0b, 0x04, 0xdf, 0x36},
	}
	OfflineWFPSubLayerKey = GUID{
		Data1: 0x101a6cde, Data2: 0x8cb6, Data3: 0x429f,
		Data4: [8]byte{0x9f, 0x63, 0xd1, 0xc5, 0x9f, 0x0a, 0xd4, 0xf3},
	}

	WFPConditionALEUserID = GUID{
		Data1: 0xaf043a0a, Data2: 0xb34d, Data3: 0x4f86,
		Data4: [8]byte{0x97, 0x9c, 0xc9, 0x03, 0x71, 0xaf, 0x6e, 0x66},
	}
	WFPLayerALEAuthConnectV4 = GUID{
		Data1: 0xc38d57d1, Data2: 0x05a7, Data3: 0x4c33,
		Data4: [8]byte{0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82},
	}
	WFPLayerALEAuthConnectV6 = GUID{
		Data1: 0x4a72393b, Data2: 0x319f, Data3: 0x44bc,
		Data4: [8]byte{0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4},
	}
	WFPLayerALEResourceAssignmentV4 = GUID{
		Data1: 0x1247d66d, Data2: 0x0b60, Data3: 0x4a15,
		Data4: [8]byte{0x8d, 0x44, 0x71, 0x55, 0xd0, 0xf5, 0x3a, 0x0c},
	}
	WFPLayerALEResourceAssignmentV6 = GUID{
		Data1: 0x55a650e1, Data2: 0x5f0a, Data3: 0x4eca,
		Data4: [8]byte{0xa6, 0x53, 0x88, 0xf5, 0x3b, 0x26, 0xaa, 0x8c},
	}
)

type WFPFilterSpec struct {
	Key         GUID
	Name        string
	Description string
	LayerKey    GUID
}

var OfflineWFPFilterSpecs = []WFPFilterSpec{
	{
		Key: GUID{
			Data1: 0x32f39d05, Data2: 0xaa4c, Data3: 0x4bf6,
			Data4: [8]byte{0x87, 0x7e, 0xeb, 0x73, 0x86, 0x99, 0x74, 0x7d},
		},
		Name:        "nexus_wfp_offline_connect_v4",
		Description: "Block Nexus offline sandbox outbound connections over IPv4",
		LayerKey:    WFPLayerALEAuthConnectV4,
	},
	{
		Key: GUID{
			Data1: 0x8d64151c, Data2: 0x6f31, Data3: 0x459f,
			Data4: [8]byte{0x80, 0x6f, 0xb3, 0x49, 0xc6, 0xdf, 0x5c, 0x89},
		},
		Name:        "nexus_wfp_offline_connect_v6",
		Description: "Block Nexus offline sandbox outbound connections over IPv6",
		LayerKey:    WFPLayerALEAuthConnectV6,
	},
	{
		Key: GUID{
			Data1: 0xdd2bba31, Data2: 0xc83a, Data3: 0x4f22,
			Data4: [8]byte{0x8a, 0xa3, 0xb1, 0x46, 0xc5, 0x0d, 0x67, 0x61},
		},
		Name:        "nexus_wfp_offline_assign_v4",
		Description: "Block Nexus offline sandbox IPv4 endpoint assignment",
		LayerKey:    WFPLayerALEResourceAssignmentV4,
	},
	{
		Key: GUID{
			Data1: 0xeedf68e8, Data2: 0xe56a, Data3: 0x4aee,
			Data4: [8]byte{0xad, 0x72, 0x09, 0x74, 0xf0, 0x10, 0x13, 0xa7},
		},
		Name:        "nexus_wfp_offline_assign_v6",
		Description: "Block Nexus offline sandbox IPv6 endpoint assignment",
		LayerKey:    WFPLayerALEResourceAssignmentV6,
	},
}
