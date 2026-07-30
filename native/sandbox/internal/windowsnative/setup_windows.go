//go:build windows

// Windows security architecture is adapted from the Apache-2.0 licensed
// openai/codex windows-sandbox-rs implementation. This NexusCode implementation
// owns its protocol, identities, storage and release lifecycle.
package windowsnative

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsmodel"
)

const (
	offlineUsername = "NexusSandboxOffline"
	onlineUsername  = "NexusSandboxOnline"
	sandboxGroup    = "NexusSandboxUsers"

	userPrivUser         = 1
	ufScript             = 0x0001
	ufPasswdCantChange   = 0x0040
	ufNormalAccount      = 0x0200
	ufDontExpirePassword = 0x10000
	nerrUserExists       = 2224
	nerrGroupExists      = 2223
	errorMemberInAlias   = 1378
	errorAliasExists     = 1379

	cryptprotectUIForbidden = 0x1
)

var (
	netapi32                    = syscall.NewLazyDLL("netapi32.dll")
	procNetUserAdd              = netapi32.NewProc("NetUserAdd")
	procNetUserSetInfo          = netapi32.NewProc("NetUserSetInfo")
	procNetLocalGroupAdd        = netapi32.NewProc("NetLocalGroupAdd")
	procNetLocalGroupAddMembers = netapi32.NewProc("NetLocalGroupAddMembers")
	procNetLocalGroupGetMembers = netapi32.NewProc("NetLocalGroupGetMembers")
	procNetApiBufferFree        = netapi32.NewProc("NetApiBufferFree")
	crypt32                     = syscall.NewLazyDLL("crypt32.dll")
	procCryptProtectData        = crypt32.NewProc("CryptProtectData")
	procCryptUnprotect          = crypt32.NewProc("CryptUnprotectData")
)

type userInfo1 struct {
	Name        *uint16
	Password    *uint16
	PasswordAge uint32
	Priv        uint32
	HomeDir     *uint16
	Comment     *uint16
	Flags       uint32
	ScriptPath  *uint16
}

type userInfo1003 struct {
	Password *uint16
}

type localGroupInfo1 struct {
	Name    *uint16
	Comment *uint16
}

type localGroupMembersInfo3 struct {
	DomainAndName *uint16
}

type localGroupMembersInfo0 struct {
	SID *syscall.SID
}

type dataBlob struct {
	Size uint32
	Data *byte
}

type credentials struct {
	OfflinePassword string `json:"offlinePassword"`
	OnlinePassword  string `json:"onlinePassword"`
}

func RequireReady() error {
	status := Status()
	if status.State != windowsmodel.SetupReady {
		return fmt.Errorf("%s; run `nexus-sandbox.exe --setup`", status.Detail)
	}
	marker, err := loadSetupMarker()
	if err != nil {
		return err
	}
	if err := validateProvisionedIdentities(marker); err != nil {
		return fmt.Errorf("Windows sandbox identities are unavailable: %w", err)
	}
	if _, err := loadCredentials(); err != nil {
		return fmt.Errorf("Windows sandbox credentials are unavailable: %w", err)
	}
	return nil
}

func VerifyInstallation() error {
	if err := RequireReady(); err != nil {
		return err
	}
	if err := verifySandboxUsersHidden(); err != nil {
		return fmt.Errorf("Windows sandbox identities are visible at sign-in: %w", err)
	}
	if err := verifyFirewallPolicy(); err != nil {
		return fmt.Errorf("Windows sandbox network policy is unavailable: %w", err)
	}
	return nil
}

func validateProvisionedIdentities(marker windowsmodel.SetupMarker) error {
	expected := map[string]string{
		offlineUsername: marker.OfflineSID,
		onlineUsername:  marker.OnlineSID,
		sandboxGroup:    marker.GroupSID,
	}
	for account, expectedSID := range expected {
		actualSID, err := accountSID(account)
		if err != nil {
			return fmt.Errorf("resolve %s: %w", account, err)
		}
		if !strings.EqualFold(actualSID, expectedSID) {
			return fmt.Errorf(
				"%s SID changed: got %s, expected %s",
				account,
				actualSID,
				expectedSID,
			)
		}
	}
	members, err := sandboxGroupMemberSIDs()
	if err != nil {
		return err
	}
	for _, expectedSID := range []string{marker.OfflineSID, marker.OnlineSID} {
		if _, ok := members[strings.ToLower(expectedSID)]; !ok {
			return fmt.Errorf("sandbox group omits identity %s", expectedSID)
		}
	}
	return nil
}

func sandboxGroupMemberSIDs() (map[string]struct{}, error) {
	name, _ := syscall.UTF16PtrFromString(sandboxGroup)
	var buffer unsafe.Pointer
	var entriesRead uint32
	var totalEntries uint32
	result, _, _ := procNetLocalGroupGetMembers.Call(
		0,
		uintptr(unsafe.Pointer(name)),
		0,
		uintptr(unsafe.Pointer(&buffer)),
		0xFFFFFFFF,
		uintptr(unsafe.Pointer(&entriesRead)),
		uintptr(unsafe.Pointer(&totalEntries)),
		0,
	)
	if result != 0 {
		return nil, fmt.Errorf("NetLocalGroupGetMembers failed with status %d", result)
	}
	if buffer != nil {
		defer procNetApiBufferFree.Call(uintptr(buffer))
	}
	members := make(map[string]struct{}, entriesRead)
	if entriesRead == 0 {
		return members, nil
	}
	entries := unsafe.Slice(
		(*localGroupMembersInfo0)(buffer),
		entriesRead,
	)
	for _, entry := range entries {
		if entry.SID == nil {
			continue
		}
		value, err := entry.SID.String()
		if err != nil {
			return nil, err
		}
		members[strings.ToLower(value)] = struct{}{}
	}
	return members, nil
}

func Status() windowsmodel.SetupStatus {
	data, err := os.ReadFile(markerPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return windowsmodel.EvaluateSetupMarker(nil)
		}
		return windowsmodel.SetupStatus{
			State:  windowsmodel.SetupCorrupt,
			Detail: fmt.Sprintf("cannot read Windows sandbox marker: %v", err),
		}
	}
	status := windowsmodel.EvaluateSetupMarker(data)
	if status.State != windowsmodel.SetupReady {
		return status
	}
	if info, err := os.Stat(credentialsPath()); err != nil || !info.Mode().IsRegular() {
		status.State = windowsmodel.SetupCorrupt
		status.Detail = "Windows sandbox protected credentials are missing"
	}
	return status
}

func Setup() error {
	if Status().State == windowsmodel.SetupReady {
		if err := VerifyInstallation(); err == nil {
			return nil
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	powershell, err := systemPowerShell()
	if err != nil {
		return err
	}
	script := fmt.Sprintf(
		"$ErrorActionPreference='Stop';"+
			"$p=Start-Process -FilePath '%s' -ArgumentList '--setup-elevated' -Verb RunAs -Wait -PassThru;"+
			"exit $p.ExitCode",
		strings.ReplaceAll(executable, "'", "''"),
	)
	command := trustedPowerShellCommand(powershell, script)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("Windows sandbox UAC setup was cancelled or failed: %w", err)
	}
	return VerifyInstallation()
}

func SetupElevated() error {
	if err := os.MkdirAll(sandboxStateDir(), 0o700); err != nil {
		return fmt.Errorf("create Windows sandbox state: %w", err)
	}
	offlinePassword, err := randomPassword()
	if err != nil {
		return err
	}
	onlinePassword, err := randomPassword()
	if err != nil {
		return err
	}
	if err := createOrUpdateLocalUser(offlineUsername, offlinePassword); err != nil {
		return fmt.Errorf("provision offline sandbox identity: %w", err)
	}
	if err := createOrUpdateLocalUser(onlineUsername, onlinePassword); err != nil {
		return fmt.Errorf("provision online sandbox identity: %w", err)
	}
	if err := createSandboxLocalGroup(); err != nil {
		return fmt.Errorf("provision sandbox identity group: %w", err)
	}
	if err := hideSandboxUsers(); err != nil {
		return fmt.Errorf("hide sandbox identities from Windows sign-in: %w", err)
	}
	offlineSID, err := accountSID(offlineUsername)
	if err != nil {
		return fmt.Errorf("resolve offline sandbox identity: %w", err)
	}
	onlineSID, err := accountSID(onlineUsername)
	if err != nil {
		return fmt.Errorf("resolve online sandbox identity: %w", err)
	}
	if offlineSID == onlineSID {
		return errors.New("Windows sandbox identities unexpectedly share a SID")
	}
	groupSID, err := accountSID(sandboxGroup)
	if err != nil {
		return fmt.Errorf("resolve sandbox identity group: %w", err)
	}
	if err := prepareRunRoot(offlineSID, onlineSID); err != nil {
		return fmt.Errorf("prepare Windows sandbox IPC root: %w", err)
	}
	if err := installFirewallPolicy(offlineSID); err != nil {
		return fmt.Errorf("install offline Windows Firewall policy: %w", err)
	}
	if err := verifyFirewallPolicyForSID(offlineSID); err != nil {
		return fmt.Errorf("verify offline Windows Firewall policy: %w", err)
	}
	credentialJSON, err := json.Marshal(credentials{
		OfflinePassword: offlinePassword,
		OnlinePassword:  onlinePassword,
	})
	if err != nil {
		return err
	}
	protected, err := dpapiProtect(credentialJSON)
	clear(credentialJSON)
	if err != nil {
		return fmt.Errorf("protect Windows sandbox credentials: %w", err)
	}
	if err := writeFileAtomic(credentialsPath(), protected, 0o600); err != nil {
		return err
	}
	marker, err := json.Marshal(windowsmodel.SetupMarker{
		SetupVersion:        windowsmodel.CurrentSetupVersion,
		OfflineSID:          offlineSID,
		OnlineSID:           onlineSID,
		GroupSID:            groupSID,
		CredentialsRevision: windowsmodel.CurrentCredentialsRevision,
		FirewallRevision:    windowsmodel.CurrentFirewallRevision,
	})
	if err != nil {
		return err
	}
	if err := writeFileAtomic(markerPath(), marker, 0o600); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "NexusCode Windows sandbox setup completed")
	return nil
}

func createSandboxLocalGroup() error {
	name, _ := syscall.UTF16PtrFromString(sandboxGroup)
	comment, _ := syscall.UTF16PtrFromString("NexusCode restricted sandbox identities")
	info := localGroupInfo1{Name: name, Comment: comment}
	var parameterError uint32
	result, _, _ := procNetLocalGroupAdd.Call(
		0,
		1,
		uintptr(unsafe.Pointer(&info)),
		uintptr(unsafe.Pointer(&parameterError)),
	)
	if result != 0 && result != nerrGroupExists && result != errorAliasExists {
		return fmt.Errorf(
			"NetLocalGroupAdd failed with status %d (parameter %d)",
			result,
			parameterError,
		)
	}
	for _, username := range []string{offlineUsername, onlineUsername} {
		member, _ := syscall.UTF16PtrFromString(username)
		memberInfo := localGroupMembersInfo3{DomainAndName: member}
		result, _, _ = procNetLocalGroupAddMembers.Call(
			0,
			uintptr(unsafe.Pointer(name)),
			3,
			uintptr(unsafe.Pointer(&memberInfo)),
			1,
		)
		if result != 0 && result != errorMemberInAlias {
			return fmt.Errorf(
				"NetLocalGroupAddMembers(%s) failed with status %d",
				username,
				result,
			)
		}
	}
	return nil
}

func loadCredentials() (credentials, error) {
	protected, err := os.ReadFile(credentialsPath())
	if err != nil {
		return credentials{}, err
	}
	plain, err := dpapiUnprotect(protected)
	if err != nil {
		return credentials{}, err
	}
	defer clear(plain)
	var result credentials
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return credentials{}, err
	}
	if err := requireJSONEOF(decoder, "protected credentials"); err != nil {
		return credentials{}, err
	}
	if result.OfflinePassword == "" || result.OnlinePassword == "" {
		return credentials{}, errors.New("protected credential payload is incomplete")
	}
	return result, nil
}

func createOrUpdateLocalUser(username, password string) error {
	name, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	secret, err := syscall.UTF16PtrFromString(password)
	if err != nil {
		return err
	}
	comment, _ := syscall.UTF16PtrFromString("NexusCode restricted sandbox identity")
	info := userInfo1{
		Name:     name,
		Password: secret,
		Priv:     userPrivUser,
		Comment:  comment,
		Flags: ufScript |
			ufPasswdCantChange |
			ufNormalAccount |
			ufDontExpirePassword,
	}
	var parameterError uint32
	result, _, _ := procNetUserAdd.Call(
		0,
		1,
		uintptr(unsafe.Pointer(&info)),
		uintptr(unsafe.Pointer(&parameterError)),
	)
	if result == 0 {
		return nil
	}
	if result != nerrUserExists {
		return fmt.Errorf("NetUserAdd failed with status %d (parameter %d)", result, parameterError)
	}
	passwordInfo := userInfo1003{Password: secret}
	result, _, _ = procNetUserSetInfo.Call(
		0,
		uintptr(unsafe.Pointer(name)),
		1003,
		uintptr(unsafe.Pointer(&passwordInfo)),
		uintptr(unsafe.Pointer(&parameterError)),
	)
	if result != 0 {
		return fmt.Errorf("NetUserSetInfo failed with status %d (parameter %d)", result, parameterError)
	}
	return nil
}

func accountSID(username string) (string, error) {
	sid, _, _, err := syscall.LookupSID("", username)
	if err != nil {
		return "", err
	}
	return sid.String()
}

func installFirewallPolicy(offlineSID string) error {
	powershell, err := systemPowerShell()
	if err != nil {
		return err
	}
	localUser := "O:LSD:(A;;CC;;;" + offlineSID + ")"
	nonLoopback := "0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
	loopback := "127.0.0.0/8','::/127"
	script := fmt.Sprintf(
		"$ErrorActionPreference='Stop';"+
			"$group='NexusCode Sandbox';"+
			"$names=@('NexusCodeSandboxOfflineGuard','NexusCodeSandboxOfflineNonLoopback','NexusCodeSandboxOfflineLoopbackTCP','NexusCodeSandboxOfflineLoopbackUDP');"+
			"foreach($name in $names){Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue|Remove-NetFirewallRule};"+
			"New-NetFirewallRule -Name $names[0] -DisplayName 'NexusCode Sandbox Offline Guard' -Group $group -Direction Outbound -Action Block -Profile Any -Enabled True -Protocol Any -RemoteAddress Any -LocalUser '%s'|Out-Null;"+
			"New-NetFirewallRule -Name $names[1] -DisplayName 'NexusCode Sandbox Offline Non-Loopback' -Group $group -Direction Outbound -Action Block -Profile Any -Enabled True -Protocol Any -RemoteAddress '%s' -LocalUser '%s'|Out-Null;"+
			"New-NetFirewallRule -Name $names[2] -DisplayName 'NexusCode Sandbox Offline Loopback TCP' -Group $group -Direction Outbound -Action Block -Profile Any -Enabled True -Protocol TCP -RemoteAddress '%s' -LocalUser '%s'|Out-Null;"+
			"New-NetFirewallRule -Name $names[3] -DisplayName 'NexusCode Sandbox Offline Loopback UDP' -Group $group -Direction Outbound -Action Block -Profile Any -Enabled True -Protocol UDP -RemoteAddress '%s' -LocalUser '%s'|Out-Null",
		localUser,
		nonLoopback,
		localUser,
		loopback,
		localUser,
		loopback,
		localUser,
	)
	output, err := trustedPowerShellCommand(powershell, script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func verifyFirewallPolicy() error {
	status := Status()
	if status.OfflineSID == "" {
		return errors.New("offline sandbox SID is unavailable")
	}
	return verifyFirewallPolicyForSID(status.OfflineSID)
}

func verifyFirewallPolicyForSID(offlineSID string) error {
	powershell, err := systemPowerShell()
	if err != nil {
		return err
	}
	script := "$ErrorActionPreference='Stop';" +
		"$sid='" + strings.ReplaceAll(offlineSID, "'", "''") + "';" +
		"if((Get-Service -Name MpsSvc -ErrorAction Stop).Status -ne 'Running'){exit 2};" +
		"$profiles=@(Get-NetFirewallProfile -ErrorAction Stop|Where-Object {$_.Enabled -eq 'True'});" +
		"if($profiles.Count -eq 0){exit 7};" +
		"foreach($profile in $profiles){if($profile.AllowLocalFirewallRules -eq $false -or $profile.AllowLocalFirewallRules -eq 'False'){exit 5}};" +
		"$names=@('NexusCodeSandboxOfflineGuard','NexusCodeSandboxOfflineNonLoopback','NexusCodeSandboxOfflineLoopbackTCP','NexusCodeSandboxOfflineLoopbackUDP');" +
		"foreach($name in $names){$r=@(Get-NetFirewallRule -Name $name -ErrorAction Stop);" +
		"if($r.Count -ne 1){exit 6};$r=$r[0];" +
		"if($r.Enabled -ne 'True' -or $r.Action -ne 'Block' -or $r.Direction -ne 'Outbound'){exit 3};" +
		"$s=$r|Get-NetFirewallSecurityFilter;" +
		"if($s.LocalUser -notmatch [regex]::Escape($sid)){exit 4}};" +
		"$guard=Get-NetFirewallRule -Name $names[0];" +
		"$guardAddress=$guard|Get-NetFirewallAddressFilter;" +
		"$guardPort=$guard|Get-NetFirewallPortFilter;" +
		"if($guardAddress.RemoteAddress -ne 'Any' -or $guardPort.Protocol -ne 'Any'){exit 8}"
	output, err := trustedPowerShellCommand(powershell, script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func hideSandboxUsers() error {
	powershell, err := systemPowerShell()
	if err != nil {
		return err
	}
	script := "$ErrorActionPreference='Stop';" +
		"$path='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList';" +
		"New-Item -Path $path -Force|Out-Null;" +
		"New-ItemProperty -Path $path -Name '" + offlineUsername + "' -PropertyType DWord -Value 0 -Force|Out-Null;" +
		"New-ItemProperty -Path $path -Name '" + onlineUsername + "' -PropertyType DWord -Value 0 -Force|Out-Null"
	output, err := trustedPowerShellCommand(powershell, script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func verifySandboxUsersHidden() error {
	powershell, err := systemPowerShell()
	if err != nil {
		return err
	}
	script := "$ErrorActionPreference='Stop';" +
		"$path='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList';" +
		"foreach($name in @('" + offlineUsername + "','" + onlineUsername + "')){" +
		"$value=(Get-ItemPropertyValue -Path $path -Name $name -ErrorAction Stop);" +
		"if([int]$value -ne 0){exit 2}}"
	output, err := trustedPowerShellCommand(powershell, script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func dpapiProtect(plain []byte) ([]byte, error) {
	return dpapiCall(procCryptProtectData, plain, "NexusCode Windows sandbox credentials")
}

func dpapiUnprotect(protected []byte) ([]byte, error) {
	return dpapiCall(procCryptUnprotect, protected, "")
}

func dpapiCall(procedure *syscall.LazyProc, input []byte, description string) ([]byte, error) {
	if len(input) == 0 {
		return nil, errors.New("DPAPI input is empty")
	}
	in := dataBlob{Size: uint32(len(input)), Data: &input[0]}
	var out dataBlob
	var descriptionPointer *uint16
	if description != "" {
		descriptionPointer, _ = syscall.UTF16PtrFromString(description)
	}
	result, _, callErr := procedure.Call(
		uintptr(unsafe.Pointer(&in)),
		uintptr(unsafe.Pointer(descriptionPointer)),
		0,
		0,
		0,
		cryptprotectUIForbidden,
		uintptr(unsafe.Pointer(&out)),
	)
	if result == 0 {
		return nil, callErr
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(out.Data))))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

func randomPassword() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%_-"
	raw := make([]byte, 40)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	for index := range raw {
		raw[index] = alphabet[int(raw[index])%len(alphabet)]
	}
	return string(raw), nil
}

func systemPowerShell() (string, error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	candidate := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("trusted Windows PowerShell is unavailable at %s", candidate)
	}
	return candidate, nil
}

func trustedPowerShellCommand(powershell string, script string) *exec.Cmd {
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	system32 := filepath.Join(systemRoot, "System32")
	powershellRoot := filepath.Dir(powershell)
	command := exec.Command(
		powershell,
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		encodePowerShell(script),
	)
	command.Dir = system32
	command.Env = []string{
		"SystemRoot=" + systemRoot,
		"WINDIR=" + systemRoot,
		"PATH=" + system32 + ";" + powershellRoot,
		"PATHEXT=.COM;.EXE;.BAT;.CMD",
		"PSModulePath=" + filepath.Join(
			system32,
			"WindowsPowerShell",
			"v1.0",
			"Modules",
		),
		"TEMP=" + os.TempDir(),
		"TMP=" + os.TempDir(),
	}
	return command
}

func encodePowerShell(script string) string {
	encoded := utf16.Encode([]rune(script))
	raw := make([]byte, len(encoded)*2)
	for index, value := range encoded {
		raw[index*2] = byte(value)
		raw[index*2+1] = byte(value >> 8)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func sandboxStateDir() string {
	root, err := os.UserConfigDir()
	if err != nil || root == "" {
		root = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
	}
	return filepath.Join(root, "NexusCode", "sandbox")
}

func markerPath() string {
	return filepath.Join(sandboxStateDir(), "setup-marker.json")
}

func credentialsPath() string {
	return filepath.Join(sandboxStateDir(), "credentials.dpapi")
}

func capabilityPath() string {
	return filepath.Join(sandboxStateDir(), "capabilities.json")
}

func aclStatePath() string {
	return filepath.Join(sandboxStateDir(), "acl-state.json")
}

func sandboxRunRoot() string {
	root := os.Getenv("ProgramData")
	if root == "" {
		root = `C:\ProgramData`
	}
	return filepath.Join(root, "NexusCode", "SandboxRuns")
}

func prepareRunRoot(offlineSID, onlineSID string) error {
	if err := os.MkdirAll(sandboxRunRoot(), 0o700); err != nil {
		return err
	}
	currentSID, err := currentUserSID()
	if err != nil {
		return err
	}
	icacls, err := systemExecutable("icacls.exe")
	if err != nil {
		return err
	}
	if err := runICACLS(icacls, sandboxRunRoot(), "/inheritance:r"); err != nil {
		return err
	}
	for _, sid := range []string{currentSID, "S-1-5-18"} {
		if err := runICACLS(
			icacls,
			sandboxRunRoot(),
			"/grant:r",
			"*"+sid+":(OI)(CI)(F)",
		); err != nil {
			return err
		}
	}
	// Sandbox identities may traverse the parent when given an unguessable run
	// directory, but cannot enumerate sibling runs. Each run directory receives
	// an identity-specific ACL immediately before its runner starts.
	for _, sid := range []string{offlineSID, onlineSID} {
		if err := runICACLS(
			icacls,
			sandboxRunRoot(),
			"/grant:r",
			"*"+sid+":(X)",
		); err != nil {
			return err
		}
	}
	return nil
}

func createPrivateRunDirectory(sandboxSID string) (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate Windows sandbox run identity: %w", err)
	}
	runDir := filepath.Join(sandboxRunRoot(), "run-"+hex.EncodeToString(random))
	if err := os.Mkdir(runDir, 0o700); err != nil {
		return "", fmt.Errorf("create Windows sandbox run directory: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(runDir)
		}
	}()
	currentSID, err := currentUserSID()
	if err != nil {
		return "", err
	}
	icacls, err := systemExecutable("icacls.exe")
	if err != nil {
		return "", err
	}
	if err := runICACLS(icacls, runDir, "/inheritance:r"); err != nil {
		return "", err
	}
	for _, sid := range []string{currentSID, sandboxSID, "S-1-5-18"} {
		if err := runICACLS(
			icacls,
			runDir,
			"/grant:r",
			"*"+sid+":(OI)(CI)(F)",
		); err != nil {
			return "", err
		}
	}
	cleanup = false
	return runDir, nil
}

func currentUserSID() (string, error) {
	current, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer current.Close()
	user, err := current.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String()
}

func writeFileAtomic(destination string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(destination), filepath.Base(destination)+".tmp-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	sourcePointer, err := syscall.UTF16PtrFromString(temp)
	if err != nil {
		return err
	}
	destinationPointer, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	result, _, callErr := procMoveFileExW.Call(
		uintptr(unsafe.Pointer(sourcePointer)),
		uintptr(unsafe.Pointer(destinationPointer)),
		moveFileReplaceExisting|moveFileWriteThrough,
	)
	if result == 0 {
		return fmt.Errorf("atomically replace %s: %w", destination, callErr)
	}
	return nil
}
