//go:build windows

package windowsnative

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsmodel"
)

const (
	fwpEmpty                  = 0
	fwpSecurityDescriptorType = 14
	fwpMatchEqual             = 0
	fwpActionBlock            = 0x00001001

	fwpmObjectPersistent = 0x00000001

	fwpEFilterNotFound = 0x80320003
	fwpENotFound       = 0x80320008
	fwpEAlreadyExists  = 0x80320009

	rpcCAuthnDefault = 0xFFFFFFFF
)

var (
	fwpuclnt                   = syscall.NewLazyDLL("fwpuclnt.dll")
	procFwpmEngineOpen0        = fwpuclnt.NewProc("FwpmEngineOpen0")
	procFwpmEngineClose0       = fwpuclnt.NewProc("FwpmEngineClose0")
	procFwpmTransactionBegin0  = fwpuclnt.NewProc("FwpmTransactionBegin0")
	procFwpmTransactionCommit0 = fwpuclnt.NewProc("FwpmTransactionCommit0")
	procFwpmTransactionAbort0  = fwpuclnt.NewProc("FwpmTransactionAbort0")
	procFwpmProviderAdd0       = fwpuclnt.NewProc("FwpmProviderAdd0")
	procFwpmSubLayerAdd0       = fwpuclnt.NewProc("FwpmSubLayerAdd0")
	procFwpmFilterAdd0         = fwpuclnt.NewProc("FwpmFilterAdd0")
	procFwpmFilterDeleteByKey0 = fwpuclnt.NewProc("FwpmFilterDeleteByKey0")
	procFwpmFilterGetByKey0    = fwpuclnt.NewProc("FwpmFilterGetByKey0")
	procFwpmFreeMemory0        = fwpuclnt.NewProc("FwpmFreeMemory0")
	procConvertStringSDToSD    = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procConvertSDToStringSD    = advapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
)

type fwpByteBlob struct {
	Size uint32
	Data *byte
}

type fwpValue0 struct {
	Type  uint32
	Value uintptr
}

type fwpConditionValue0 struct {
	Type  uint32
	Value unsafe.Pointer
}

type fwpmDisplayData0 struct {
	Name        *uint16
	Description *uint16
}

type fwpmSession0 struct {
	SessionKey        windowsmodel.GUID
	DisplayData       fwpmDisplayData0
	Flags             uint32
	TransactionWaitMS uint32
	ProcessID         uint32
	SID               *syscall.SID
	Username          *uint16
	KernelMode        int32
}

type fwpmProvider0 struct {
	ProviderKey  windowsmodel.GUID
	DisplayData  fwpmDisplayData0
	Flags        uint32
	ProviderData fwpByteBlob
	ServiceName  *uint16
}

type fwpmSubLayer0 struct {
	SubLayerKey  windowsmodel.GUID
	DisplayData  fwpmDisplayData0
	Flags        uint32
	ProviderKey  *windowsmodel.GUID
	ProviderData fwpByteBlob
	Weight       uint16
}

type fwpmFilterCondition0 struct {
	FieldKey       windowsmodel.GUID
	MatchType      uint32
	ConditionValue fwpConditionValue0
}

type fwpmAction0 struct {
	Type  uint32
	Value windowsmodel.GUID
}

type fwpmFilter0 struct {
	FilterKey           windowsmodel.GUID
	DisplayData         fwpmDisplayData0
	Flags               uint32
	ProviderKey         *windowsmodel.GUID
	ProviderData        fwpByteBlob
	LayerKey            windowsmodel.GUID
	SubLayerKey         windowsmodel.GUID
	Weight              fwpValue0
	NumFilterConditions uint32
	FilterCondition     *fwpmFilterCondition0
	Action              fwpmAction0
	Context             windowsmodel.GUID
	Reserved            *windowsmodel.GUID
	FilterID            uint64
	EffectiveWeight     fwpValue0
}

type wfpEngine struct {
	Handle syscall.Handle
}

func openWFPEngine() (*wfpEngine, error) {
	name, err := syscall.UTF16PtrFromString("NexusCode Windows Sandbox WFP")
	if err != nil {
		return nil, err
	}
	session := fwpmSession0{
		DisplayData:       fwpmDisplayData0{Name: name},
		TransactionWaitMS: infinite,
	}
	var handle syscall.Handle
	result, _, _ := procFwpmEngineOpen0.Call(
		0,
		rpcCAuthnDefault,
		0,
		uintptr(unsafe.Pointer(&session)),
		uintptr(unsafe.Pointer(&handle)),
	)
	if err := wfpResult(result, "FwpmEngineOpen0"); err != nil {
		return nil, err
	}
	return &wfpEngine{Handle: handle}, nil
}

func (engine *wfpEngine) Close() {
	if engine != nil && engine.Handle != 0 {
		procFwpmEngineClose0.Call(uintptr(engine.Handle))
		engine.Handle = 0
	}
}

func installOfflineWFPFilters(offlineSID string) error {
	engine, err := openWFPEngine()
	if err != nil {
		return err
	}
	defer engine.Close()
	if result, _, _ := procFwpmTransactionBegin0.Call(uintptr(engine.Handle), 0); result != 0 {
		return wfpResult(result, "FwpmTransactionBegin0")
	}
	committed := false
	defer func() {
		if !committed {
			procFwpmTransactionAbort0.Call(uintptr(engine.Handle))
		}
	}()

	if err := ensureWFPProvider(engine.Handle); err != nil {
		return err
	}
	if err := ensureWFPSubLayer(engine.Handle); err != nil {
		return err
	}
	securityDescriptor, descriptorSize, err := offlineUserSecurityDescriptor(offlineSID)
	if err != nil {
		return err
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(securityDescriptor)))
	descriptorBlob := fwpByteBlob{
		Size: descriptorSize,
		Data: (*byte)(securityDescriptor),
	}

	for _, spec := range windowsmodel.OfflineWFPFilterSpecs {
		if err := replaceOfflineWFPFilter(engine.Handle, spec, &descriptorBlob); err != nil {
			return err
		}
	}
	if result, _, _ := procFwpmTransactionCommit0.Call(uintptr(engine.Handle)); result != 0 {
		return wfpResult(result, "FwpmTransactionCommit0")
	}
	committed = true
	return verifyOfflineWFPFiltersWithEngine(engine.Handle, offlineSID)
}

func ensureWFPProvider(engine syscall.Handle) error {
	name, _ := syscall.UTF16PtrFromString("NexusCode Windows Sandbox WFP")
	description, _ := syscall.UTF16PtrFromString(
		"Persistent WFP provider for NexusCode offline sandbox filters",
	)
	provider := fwpmProvider0{
		ProviderKey: windowsmodel.OfflineWFPProviderKey,
		DisplayData: fwpmDisplayData0{
			Name: name, Description: description,
		},
		Flags: fwpmObjectPersistent,
	}
	result, _, _ := procFwpmProviderAdd0.Call(
		uintptr(engine),
		uintptr(unsafe.Pointer(&provider)),
		0,
	)
	return wfpResultAllow(
		result,
		"FwpmProviderAdd0",
		fwpEAlreadyExists,
	)
}

func ensureWFPSubLayer(engine syscall.Handle) error {
	name, _ := syscall.UTF16PtrFromString("NexusCode Windows Sandbox WFP")
	description, _ := syscall.UTF16PtrFromString(
		"Persistent WFP sublayer for NexusCode offline sandbox filters",
	)
	providerKey := windowsmodel.OfflineWFPProviderKey
	subLayer := fwpmSubLayer0{
		SubLayerKey: windowsmodel.OfflineWFPSubLayerKey,
		DisplayData: fwpmDisplayData0{
			Name: name, Description: description,
		},
		Flags:       fwpmObjectPersistent,
		ProviderKey: &providerKey,
		Weight:      0x8000,
	}
	result, _, _ := procFwpmSubLayerAdd0.Call(
		uintptr(engine),
		uintptr(unsafe.Pointer(&subLayer)),
		0,
	)
	return wfpResultAllow(
		result,
		"FwpmSubLayerAdd0",
		fwpEAlreadyExists,
	)
}

func replaceOfflineWFPFilter(
	engine syscall.Handle,
	spec windowsmodel.WFPFilterSpec,
	descriptor *fwpByteBlob,
) error {
	result, _, _ := procFwpmFilterDeleteByKey0.Call(
		uintptr(engine),
		uintptr(unsafe.Pointer(&spec.Key)),
	)
	if err := wfpResultAllow(
		result,
		"FwpmFilterDeleteByKey0("+spec.Name+")",
		fwpEFilterNotFound,
		fwpENotFound,
	); err != nil {
		return err
	}
	name, _ := syscall.UTF16PtrFromString(spec.Name)
	description, _ := syscall.UTF16PtrFromString(spec.Description)
	providerKey := windowsmodel.OfflineWFPProviderKey
	condition := fwpmFilterCondition0{
		FieldKey:  windowsmodel.WFPConditionALEUserID,
		MatchType: fwpMatchEqual,
		ConditionValue: fwpConditionValue0{
			Type:  fwpSecurityDescriptorType,
			Value: unsafe.Pointer(descriptor),
		},
	}
	filter := fwpmFilter0{
		FilterKey: spec.Key,
		DisplayData: fwpmDisplayData0{
			Name: name, Description: description,
		},
		Flags:               fwpmObjectPersistent,
		ProviderKey:         &providerKey,
		LayerKey:            spec.LayerKey,
		SubLayerKey:         windowsmodel.OfflineWFPSubLayerKey,
		Weight:              fwpValue0{Type: fwpEmpty},
		NumFilterConditions: 1,
		FilterCondition:     &condition,
		Action:              fwpmAction0{Type: fwpActionBlock},
		EffectiveWeight:     fwpValue0{Type: fwpEmpty},
	}
	var filterID uint64
	result, _, _ = procFwpmFilterAdd0.Call(
		uintptr(engine),
		uintptr(unsafe.Pointer(&filter)),
		0,
		uintptr(unsafe.Pointer(&filterID)),
	)
	return wfpResult(result, "FwpmFilterAdd0("+spec.Name+")")
}

func offlineUserSecurityDescriptor(offlineSID string) (unsafe.Pointer, uint32, error) {
	value, err := syscall.UTF16PtrFromString("D:(A;;CC;;;" + offlineSID + ")")
	if err != nil {
		return nil, 0, err
	}
	var descriptor unsafe.Pointer
	var size uint32
	result, _, callErr := procConvertStringSDToSD.Call(
		uintptr(unsafe.Pointer(value)),
		1,
		uintptr(unsafe.Pointer(&descriptor)),
		uintptr(unsafe.Pointer(&size)),
	)
	if result == 0 {
		return nil, 0, fmt.Errorf(
			"ConvertStringSecurityDescriptorToSecurityDescriptorW failed: %w",
			callErr,
		)
	}
	if descriptor == nil || size == 0 {
		if descriptor != nil {
			syscall.LocalFree(syscall.Handle(uintptr(descriptor)))
		}
		return nil, 0, fmt.Errorf("offline WFP security descriptor is empty")
	}
	return descriptor, size, nil
}

func verifyOfflineWFPFilters() error {
	status := Status()
	if status.OfflineSID == "" {
		return fmt.Errorf("offline sandbox SID is unavailable")
	}
	engine, err := openWFPEngine()
	if err != nil {
		return err
	}
	defer engine.Close()
	return verifyOfflineWFPFiltersWithEngine(engine.Handle, status.OfflineSID)
}

func verifyOfflineWFPFiltersWithEngine(engine syscall.Handle, offlineSID string) error {
	for _, spec := range windowsmodel.OfflineWFPFilterSpecs {
		var filter *fwpmFilter0
		result, _, _ := procFwpmFilterGetByKey0.Call(
			uintptr(engine),
			uintptr(unsafe.Pointer(&spec.Key)),
			uintptr(unsafe.Pointer(&filter)),
		)
		if err := wfpResult(result, "FwpmFilterGetByKey0("+spec.Name+")"); err != nil {
			return err
		}
		if filter == nil {
			return fmt.Errorf("WFP filter %s returned no payload", spec.Name)
		}
		if filter.FilterKey != spec.Key ||
			filter.LayerKey != spec.LayerKey ||
			filter.SubLayerKey != windowsmodel.OfflineWFPSubLayerKey ||
			filter.Flags&fwpmObjectPersistent == 0 ||
			filter.ProviderKey == nil ||
			*filter.ProviderKey != windowsmodel.OfflineWFPProviderKey ||
			filter.Action.Type != fwpActionBlock ||
			filter.NumFilterConditions != 1 ||
			filter.FilterCondition == nil {
			freeWFPObject(unsafe.Pointer(filter))
			return fmt.Errorf("WFP filter %s has an unexpected shape", spec.Name)
		}
		condition := filter.FilterCondition
		if condition.FieldKey != windowsmodel.WFPConditionALEUserID ||
			condition.MatchType != fwpMatchEqual ||
			condition.ConditionValue.Type != fwpSecurityDescriptorType ||
			condition.ConditionValue.Value == nil {
			freeWFPObject(unsafe.Pointer(filter))
			return fmt.Errorf("WFP filter %s has an invalid user condition", spec.Name)
		}
		descriptor := (*fwpByteBlob)(condition.ConditionValue.Value)
		if descriptor == nil ||
			descriptor.Size == 0 ||
			descriptor.Data == nil ||
			!securityDescriptorContainsSID(descriptor.Data, offlineSID) {
			freeWFPObject(unsafe.Pointer(filter))
			return fmt.Errorf("WFP filter %s targets the wrong sandbox identity", spec.Name)
		}
		freeWFPObject(unsafe.Pointer(filter))
	}
	return nil
}

func securityDescriptorContainsSID(descriptor *byte, expectedSID string) bool {
	var value *uint16
	var length uint32
	result, _, _ := procConvertSDToStringSD.Call(
		uintptr(unsafe.Pointer(descriptor)),
		1,
		0x00000004, // DACL_SECURITY_INFORMATION
		uintptr(unsafe.Pointer(&value)),
		uintptr(unsafe.Pointer(&length)),
	)
	if result == 0 || value == nil || length == 0 {
		return false
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(value))))
	sddl := syscall.UTF16ToString(unsafe.Slice(value, length))
	return strings.Contains(strings.ToLower(sddl), strings.ToLower(expectedSID))
}

func freeWFPObject(value unsafe.Pointer) {
	if value == nil {
		return
	}
	pointer := value
	procFwpmFreeMemory0.Call(uintptr(unsafe.Pointer(&pointer)))
}

func wfpResult(result uintptr, operation string) error {
	return wfpResultAllow(result, operation)
}

func wfpResultAllow(result uintptr, operation string, allowed ...uintptr) error {
	if result == 0 {
		return nil
	}
	for _, candidate := range allowed {
		if result == candidate {
			return nil
		}
	}
	return fmt.Errorf("%s failed: 0x%08X", operation, uint32(result))
}
