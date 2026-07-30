//go:build linux && amd64

package linuxseccomp

const auditArchitecture uint32 = 0xc000003e

const (
	sysSocket          uint32 = 41
	sysConnect         uint32 = 42
	sysAccept          uint32 = 43
	sysSendto          uint32 = 44
	sysShutdown        uint32 = 48
	sysBind            uint32 = 49
	sysListen          uint32 = 50
	sysGetsockname     uint32 = 51
	sysGetpeername     uint32 = 52
	sysSocketpair      uint32 = 53
	sysSetsockopt      uint32 = 54
	sysGetsockopt      uint32 = 55
	sysPtrace          uint32 = 101
	sysAccept4         uint32 = 288
	sysRecvmmsg        uint32 = 299
	sysProcessVMReadv  uint32 = 310
	sysProcessVMWritev uint32 = 311
	sysSendmmsg        uint32 = 307
	sysIoUringSetup    uint32 = 425
	sysIoUringEnter    uint32 = 426
	sysIoUringRegister uint32 = 427
)

var alwaysDeniedSyscalls = []uint32{
	sysPtrace,
	sysProcessVMReadv,
	sysProcessVMWritev,
	sysIoUringSetup,
	sysIoUringEnter,
	sysIoUringRegister,
}

var networkDeniedSyscalls = []uint32{
	sysConnect,
	sysAccept,
	sysAccept4,
	sysBind,
	sysListen,
	sysGetpeername,
	sysGetsockname,
	sysShutdown,
	sysSendto,
	sysSendmmsg,
	sysRecvmmsg,
	sysGetsockopt,
	sysSetsockopt,
}
