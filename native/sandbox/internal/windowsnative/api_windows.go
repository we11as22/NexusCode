//go:build windows

package windowsnative

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

const (
	createUnicodeEnvironment   = 0x00000400
	createSuspended            = 0x00000004
	extendedStartupInfoPresent = 0x00080000
	createNoWindow             = 0x08000000

	startfUseStdHandles = 0x00000100

	procThreadAttributeHandleList = 0x00020002
	procThreadAttributeJobList    = 0x0002000D

	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000

	disableMaxPrivilege = 0x00000001
	luaToken            = 0x00000004
	writeRestricted     = 0x00000008
	genericAll          = 0x10000000
	grantAccess         = 1
	trusteeIsSID        = 0
	trusteeIsUnknown    = 0
	tokenDefaultDACL    = 6
	errorSuccess        = 0

	waitObject0 = 0
	infinite    = 0xFFFFFFFF

	moveFileReplaceExisting = 0x00000001
	moveFileWriteThrough    = 0x00000008
)

var (
	advapi32                    = syscall.NewLazyDLL("advapi32.dll")
	procCreateProcessWithLogonW = advapi32.NewProc("CreateProcessWithLogonW")
	procCreateRestrictedToken   = advapi32.NewProc("CreateRestrictedToken")
	procLookupPrivilegeValueW   = advapi32.NewProc("LookupPrivilegeValueW")
	procAdjustTokenPrivileges   = advapi32.NewProc("AdjustTokenPrivileges")
	procSetEntriesInACLW        = advapi32.NewProc("SetEntriesInAclW")
	procSetTokenInformation     = advapi32.NewProc("SetTokenInformation")
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW        = kernel32.NewProc("CreateJobObjectW")
	procCreateMutexW            = kernel32.NewProc("CreateMutexW")
	procReleaseMutex            = kernel32.NewProc("ReleaseMutex")
	procSetInformationJobObject = kernel32.NewProc("SetInformationJobObject")
	procTerminateJobObject      = kernel32.NewProc("TerminateJobObject")
	procAssignProcessToJob      = kernel32.NewProc("AssignProcessToJobObject")
	procResumeThread            = kernel32.NewProc("ResumeThread")
	procInitializeAttributeList = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateAttribute         = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteAttributeList     = kernel32.NewProc("DeleteProcThreadAttributeList")
	procMoveFileExW             = kernel32.NewProc("MoveFileExW")
	user32                      = syscall.NewLazyDLL("user32.dll")
	procCreateDesktopW          = user32.NewProc("CreateDesktopW")
	procCloseDesktop            = user32.NewProc("CloseDesktop")
)

func withAuthorityLock(run func() error) error {
	name, _ := syscall.UTF16PtrFromString(`Local\NexusCodeSandboxAuthority`)
	handle, _, callErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return fmt.Errorf("CreateMutexW failed: %w", callErr)
	}
	mutex := syscall.Handle(handle)
	defer syscall.CloseHandle(mutex)
	event, err := syscall.WaitForSingleObject(mutex, 30_000)
	if err != nil || event != waitObject0 && event != 0x80 {
		return fmt.Errorf("wait for sandbox authority lock failed: event=%d err=%w", event, err)
	}
	defer procReleaseMutex.Call(uintptr(mutex))
	return run()
}

type procThreadAttributeList struct{}

type windowsACL struct{}

type trusteeW struct {
	MultipleTrustee          *trusteeW
	MultipleTrusteeOperation uint32
	TrusteeForm              uint32
	TrusteeType              uint32
	Name                     *uint16
}

type explicitAccessW struct {
	Permissions uint32
	AccessMode  uint32
	Inheritance uint32
	Trustee     trusteeW
}

type tokenDefaultDACLInfo struct {
	DefaultDACL *windowsACL
}

type tokenGroups struct {
	GroupCount uint32
	Groups     [1]syscall.SIDAndAttributes
}

type luid struct {
	LowPart  uint32
	HighPart int32
}

type luidAndAttributes struct {
	LUID       luid
	Attributes uint32
}

type tokenPrivileges struct {
	PrivilegeCount uint32
	Privileges     [1]luidAndAttributes
}

type startupInfoEx struct {
	syscall.StartupInfo
	AttributeList *procThreadAttributeList
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobExtendedLimitInformation struct {
	BasicLimitInformation jobBasicLimitInformation
	IOInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type attributeList struct {
	buffer []byte
	list   *procThreadAttributeList
}

func newAttributeList(count uint32) (*attributeList, error) {
	var size uintptr
	result, _, callErr := procInitializeAttributeList.Call(0, uintptr(count), 0, uintptr(unsafe.Pointer(&size)))
	if result != 0 || size == 0 {
		return nil, fmt.Errorf("query process attribute list size failed: %w", callErr)
	}
	buffer := make([]byte, size)
	list := (*procThreadAttributeList)(unsafe.Pointer(&buffer[0]))
	result, _, callErr = procInitializeAttributeList.Call(
		uintptr(unsafe.Pointer(list)),
		uintptr(count),
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if result == 0 {
		return nil, fmt.Errorf("initialize process attribute list failed: %w", callErr)
	}
	return &attributeList{buffer: buffer, list: list}, nil
}

func (attributes *attributeList) update(attribute uintptr, value unsafe.Pointer, size uintptr) error {
	result, _, callErr := procUpdateAttribute.Call(
		uintptr(unsafe.Pointer(attributes.list)),
		0,
		attribute,
		uintptr(value),
		size,
		0,
		0,
	)
	if result == 0 {
		return fmt.Errorf("update process attribute %#x failed: %w", attribute, callErr)
	}
	return nil
}

func (attributes *attributeList) close() {
	if attributes != nil && attributes.list != nil {
		procDeleteAttributeList.Call(uintptr(unsafe.Pointer(attributes.list)))
	}
}

func createKillOnCloseJob() (syscall.Handle, error) {
	handle, _, callErr := procCreateJobObjectW.Call(0, 0)
	if handle == 0 {
		return 0, fmt.Errorf("CreateJobObjectW failed: %w", callErr)
	}
	job := syscall.Handle(handle)
	limits := jobExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	result, _, callErr := procSetInformationJobObject.Call(
		uintptr(job),
		jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		unsafe.Sizeof(limits),
	)
	if result == 0 {
		syscall.CloseHandle(job)
		return 0, fmt.Errorf("SetInformationJobObject failed: %w", callErr)
	}
	return job, nil
}

func terminateJob(job syscall.Handle, code uint32) error {
	result, _, callErr := procTerminateJobObject.Call(uintptr(job), uintptr(code))
	if result == 0 {
		return callErr
	}
	return nil
}

func createRestrictedPrimaryToken(
	restrictingSIDStrings []string,
	userSID string,
) (syscall.Token, error) {
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0, err
	}
	var base syscall.Token
	if err := syscall.OpenProcessToken(process, syscall.TOKEN_ALL_ACCESS, &base); err != nil {
		return 0, fmt.Errorf("OpenProcessToken failed: %w", err)
	}
	defer base.Close()

	// Match the elevated Codex token shape: active root capabilities, the
	// dedicated token user, its logon SID, and Everyone. Deliberately do not add
	// the Nexus sandbox group or BUILTIN\Users as restricting SIDs. Those groups
	// satisfy the normal access pass, while a matching root capability must
	// satisfy the restricted write pass. Adding the group here would silently
	// turn a prior workspace-write ACL into authority during a later read-only
	// command.
	capabilityValues := uniqueStrings(restrictingSIDStrings)
	if len(capabilityValues) == 0 {
		return 0, errors.New("restricted Windows token has no active filesystem capability")
	}
	logonSID, logonBuffer, err := tokenLogonSID(base)
	if err != nil {
		return 0, err
	}
	// Keep the GetTokenInformation buffer live until CreateRestrictedToken and
	// SetTokenInformation have consumed the SID pointer.
	_ = logonBuffer
	logonSIDString, err := logonSID.String()
	if err != nil {
		return 0, fmt.Errorf("format Windows logon SID: %w", err)
	}
	values := uniqueStrings(append(
		append(append([]string(nil), capabilityValues...), userSID),
		logonSIDString,
		"S-1-1-0", // Everyone
	))
	sids := make([]*syscall.SID, 0, len(values))
	for _, value := range values {
		sid, err := syscall.StringToSid(value)
		if err != nil {
			return 0, fmt.Errorf("parse restricting SID %q: %w", value, err)
		}
		sids = append(sids, sid)
	}
	entries := make([]syscall.SIDAndAttributes, len(sids))
	for index, sid := range sids {
		entries[index] = syscall.SIDAndAttributes{Sid: sid}
	}
	var restricted syscall.Token
	result, _, callErr := procCreateRestrictedToken.Call(
		uintptr(base),
		disableMaxPrivilege|luaToken|writeRestricted,
		0,
		0,
		0,
		0,
		uintptr(len(entries)),
		uintptr(unsafe.Pointer(&entries[0])),
		uintptr(unsafe.Pointer(&restricted)),
	)
	if result == 0 {
		return 0, fmt.Errorf("CreateRestrictedToken failed: %w", callErr)
	}
	daclValues := uniqueStrings(append(
		append([]string(nil), capabilityValues...),
		logonSIDString,
		"S-1-1-0",
	))
	daclSIDs := make([]*syscall.SID, 0, len(daclValues))
	for _, value := range daclValues {
		sid, err := syscall.StringToSid(value)
		if err != nil {
			restricted.Close()
			return 0, fmt.Errorf("parse default DACL SID %q: %w", value, err)
		}
		daclSIDs = append(daclSIDs, sid)
	}
	if err := setRestrictedTokenDefaultDACL(restricted, daclSIDs); err != nil {
		restricted.Close()
		return 0, err
	}
	if err := enableTokenPrivilege(restricted, "SeChangeNotifyPrivilege"); err != nil {
		restricted.Close()
		return 0, err
	}
	return restricted, nil
}

func tokenLogonSID(token syscall.Token) (*syscall.SID, []byte, error) {
	var needed uint32
	_ = syscall.GetTokenInformation(token, syscall.TokenGroups, nil, 0, &needed)
	if needed == 0 || needed > 16<<20 {
		return nil, nil, fmt.Errorf("query Windows token groups returned invalid size %d", needed)
	}
	buffer := make([]byte, needed)
	if err := syscall.GetTokenInformation(
		token,
		syscall.TokenGroups,
		&buffer[0],
		uint32(len(buffer)),
		&needed,
	); err != nil {
		return nil, nil, fmt.Errorf("read Windows token groups: %w", err)
	}
	groups := (*tokenGroups)(unsafe.Pointer(&buffer[0]))
	offset := unsafe.Offsetof(groups.Groups)
	entrySize := unsafe.Sizeof(groups.Groups[0])
	if groups.GroupCount == 0 ||
		uint64(offset)+uint64(groups.GroupCount)*uint64(entrySize) > uint64(len(buffer)) {
		return nil, nil, errors.New("Windows token groups payload is malformed")
	}
	const seGroupLogonID = 0xC0000000
	entries := unsafe.Slice(&groups.Groups[0], groups.GroupCount)
	for _, entry := range entries {
		if entry.Sid != nil && entry.Attributes&seGroupLogonID == seGroupLogonID {
			return entry.Sid, buffer, nil
		}
	}
	return nil, nil, errors.New("Windows token has no logon SID")
}

func enableTokenPrivilege(token syscall.Token, name string) error {
	namePointer, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var identifier luid
	result, _, callErr := procLookupPrivilegeValueW.Call(
		0,
		uintptr(unsafe.Pointer(namePointer)),
		uintptr(unsafe.Pointer(&identifier)),
	)
	if result == 0 {
		return fmt.Errorf("LookupPrivilegeValueW(%s) failed: %w", name, callErr)
	}
	const sePrivilegeEnabled = 0x00000002
	privileges := tokenPrivileges{
		PrivilegeCount: 1,
		Privileges: [1]luidAndAttributes{{
			LUID:       identifier,
			Attributes: sePrivilegeEnabled,
		}},
	}
	result, _, callErr = procAdjustTokenPrivileges.Call(
		uintptr(token),
		0,
		uintptr(unsafe.Pointer(&privileges)),
		0,
		0,
		0,
	)
	if result == 0 {
		return fmt.Errorf("AdjustTokenPrivileges(%s) failed: %w", name, callErr)
	}
	const errorNotAllAssigned syscall.Errno = 1300
	if errors.Is(callErr, errorNotAllAssigned) {
		return fmt.Errorf("token privilege %s is unavailable", name)
	}
	return nil
}

func setRestrictedTokenDefaultDACL(token syscall.Token, sids []*syscall.SID) error {
	if len(sids) == 0 {
		return nil
	}
	entries := make([]explicitAccessW, len(sids))
	for index, sid := range sids {
		entries[index] = explicitAccessW{
			Permissions: genericAll,
			AccessMode:  grantAccess,
			Trustee: trusteeW{
				TrusteeForm: trusteeIsSID,
				TrusteeType: trusteeIsUnknown,
				Name:        (*uint16)(unsafe.Pointer(sid)),
			},
		}
	}
	var acl *windowsACL
	result, _, callErr := procSetEntriesInACLW.Call(
		uintptr(len(entries)),
		uintptr(unsafe.Pointer(&entries[0])),
		0,
		uintptr(unsafe.Pointer(&acl)),
	)
	if result != errorSuccess {
		return fmt.Errorf("SetEntriesInAclW failed with status %d: %w", result, callErr)
	}
	if acl != nil {
		defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(acl))))
	}
	info := tokenDefaultDACLInfo{DefaultDACL: acl}
	result, _, callErr = procSetTokenInformation.Call(
		uintptr(token),
		tokenDefaultDACL,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if result == 0 {
		return fmt.Errorf("SetTokenInformation(TokenDefaultDacl) failed: %w", callErr)
	}
	return nil
}

func createProcessWithLogon(
	username string,
	password string,
	argv []string,
	cwd string,
	job syscall.Handle,
) (syscall.ProcessInformation, error) {
	var info syscall.ProcessInformation
	user, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return info, err
	}
	domain, _ := syscall.UTF16PtrFromString(".")
	secret, err := syscall.UTF16PtrFromString(password)
	if err != nil {
		return info, err
	}
	commandLine, err := syscall.UTF16FromString(composeCommandLine(argv))
	if err != nil {
		return info, err
	}
	application, err := syscall.UTF16PtrFromString(argv[0])
	if err != nil {
		return info, err
	}
	currentDirectory, err := syscall.UTF16PtrFromString(cwd)
	if err != nil {
		return info, err
	}
	startup := syscall.StartupInfo{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	result, _, callErr := procCreateProcessWithLogonW.Call(
		uintptr(unsafe.Pointer(user)),
		uintptr(unsafe.Pointer(domain)),
		uintptr(unsafe.Pointer(secret)),
		0,
		uintptr(unsafe.Pointer(application)),
		uintptr(unsafe.Pointer(&commandLine[0])),
		createUnicodeEnvironment|createSuspended|createNoWindow,
		0,
		uintptr(unsafe.Pointer(currentDirectory)),
		uintptr(unsafe.Pointer(&startup)),
		uintptr(unsafe.Pointer(&info)),
	)
	if result == 0 {
		return info, fmt.Errorf("CreateProcessWithLogonW failed: %w", callErr)
	}
	assigned, _, assignErr := procAssignProcessToJob.Call(
		uintptr(job),
		uintptr(info.Process),
	)
	if assigned == 0 {
		_ = syscall.TerminateProcess(info.Process, 125)
		_ = syscall.CloseHandle(info.Thread)
		_ = syscall.CloseHandle(info.Process)
		return syscall.ProcessInformation{}, fmt.Errorf(
			"AssignProcessToJobObject for Windows runner failed: %w",
			assignErr,
		)
	}
	resumed, _, resumeErr := procResumeThread.Call(uintptr(info.Thread))
	if resumed == 0xFFFFFFFF {
		_ = terminateJob(job, 125)
		_ = syscall.CloseHandle(info.Thread)
		_ = syscall.CloseHandle(info.Process)
		return syscall.ProcessInformation{}, fmt.Errorf(
			"ResumeThread for Windows runner failed: %w",
			resumeErr,
		)
	}
	return info, nil
}

func createRestrictedProcess(
	token syscall.Token,
	argv []string,
	cwd string,
	environment []string,
	stdin syscall.Handle,
	stdout syscall.Handle,
	stderr syscall.Handle,
	job syscall.Handle,
	desktop *uint16,
) (syscall.ProcessInformation, error) {
	var info syscall.ProcessInformation
	commandLine, err := syscall.UTF16FromString(composeCommandLine(argv))
	if err != nil {
		return info, err
	}
	currentDirectory, err := syscall.UTF16PtrFromString(cwd)
	if err != nil {
		return info, err
	}
	envBlock, err := environmentBlock(environment)
	if err != nil {
		return info, err
	}
	handles := []syscall.Handle{stdin, stdout, stderr}
	for _, handle := range handles {
		if err := syscall.SetHandleInformation(handle, syscall.HANDLE_FLAG_INHERIT, syscall.HANDLE_FLAG_INHERIT); err != nil {
			return info, fmt.Errorf("mark stdio handle inheritable: %w", err)
		}
	}
	attributes, err := newAttributeList(2)
	if err != nil {
		return info, err
	}
	defer attributes.close()
	if err := attributes.update(
		procThreadAttributeHandleList,
		unsafe.Pointer(&handles[0]),
		uintptr(len(handles))*unsafe.Sizeof(handles[0]),
	); err != nil {
		return info, err
	}
	jobs := []syscall.Handle{job}
	if err := attributes.update(
		procThreadAttributeJobList,
		unsafe.Pointer(&jobs[0]),
		unsafe.Sizeof(jobs[0]),
	); err != nil {
		return info, err
	}
	startup := startupInfoEx{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = startfUseStdHandles
	startup.StdInput = stdin
	startup.StdOutput = stdout
	startup.StdErr = stderr
	startup.Desktop = desktop
	startup.AttributeList = attributes.list
	err = syscall.CreateProcessAsUser(
		token,
		nil,
		&commandLine[0],
		nil,
		nil,
		true,
		createUnicodeEnvironment|extendedStartupInfoPresent|createNoWindow,
		&envBlock[0],
		currentDirectory,
		&startup.StartupInfo,
		&info,
	)
	if err != nil {
		return syscall.ProcessInformation{}, fmt.Errorf("CreateProcessAsUserW failed: %w", err)
	}
	return info, nil
}

type privateDesktop struct {
	handle uintptr
	name   *uint16
}

func createPrivateDesktop() (*privateDesktop, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	shortName := "NexusSandboxDesktop-" + hex.EncodeToString(random)
	shortNameWide, err := syscall.UTF16PtrFromString(shortName)
	if err != nil {
		return nil, err
	}
	const desktopAllAccess = 0x000F01FF
	handle, _, callErr := procCreateDesktopW.Call(
		uintptr(unsafe.Pointer(shortNameWide)),
		0,
		0,
		0,
		desktopAllAccess,
		0,
	)
	if handle == 0 {
		return nil, fmt.Errorf("CreateDesktopW failed: %w", callErr)
	}
	startupName, err := syscall.UTF16PtrFromString(`Winsta0\` + shortName)
	if err != nil {
		procCloseDesktop.Call(handle)
		return nil, err
	}
	return &privateDesktop{handle: handle, name: startupName}, nil
}

func (desktop *privateDesktop) Close() {
	if desktop != nil && desktop.handle != 0 {
		procCloseDesktop.Call(desktop.handle)
		desktop.handle = 0
	}
}

func composeCommandLine(argv []string) string {
	escaped := make([]string, len(argv))
	for index, argument := range argv {
		escaped[index] = syscall.EscapeArg(argument)
	}
	return strings.Join(escaped, " ")
}

func environmentBlock(environment []string) ([]uint16, error) {
	ordered := append([]string(nil), environment...)
	sort.SliceStable(ordered, func(left, right int) bool {
		return strings.ToUpper(ordered[left]) < strings.ToUpper(ordered[right])
	})
	block := make([]uint16, 0)
	for _, entry := range ordered {
		encoded, err := syscall.UTF16FromString(entry)
		if err != nil {
			return nil, err
		}
		block = append(block, encoded...)
	}
	// A Windows environment block is terminated by two NUL code units. Each
	// non-empty entry already contributes its own trailing NUL; the explicit
	// append below adds the second one. The empty-environment case needs both.
	if len(block) == 0 {
		block = append(block, 0)
	}
	block = append(block, 0)
	return block, nil
}
