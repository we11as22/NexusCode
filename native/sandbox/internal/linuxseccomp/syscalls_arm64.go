//go:build linux && arm64

package linuxseccomp

const auditArchitecture uint32 = 0xc00000b7

const (
	sysSocket          uint32 = 198
	sysSocketpair      uint32 = 199
	sysBind            uint32 = 200
	sysListen          uint32 = 201
	sysAccept          uint32 = 202
	sysConnect         uint32 = 203
	sysGetsockname     uint32 = 204
	sysGetpeername     uint32 = 205
	sysSendto          uint32 = 206
	sysSetsockopt      uint32 = 208
	sysGetsockopt      uint32 = 209
	sysShutdown        uint32 = 210
	sysPtrace          uint32 = 117
	sysAccept4         uint32 = 242
	sysRecvmmsg        uint32 = 243
	sysSendmmsg        uint32 = 269
	sysProcessVMReadv  uint32 = 270
	sysProcessVMWritev uint32 = 271
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
