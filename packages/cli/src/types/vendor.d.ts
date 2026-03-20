declare module "lodash-es"

declare module "debug"

declare module "shell-quote"

declare module "semver"

declare module "sharp"

declare module "@statsig/js-client" {
  export interface StatsigUser {
    userID?: string
    email?: string
    appVersion?: string
    userAgent?: string
    customIDs?: Record<string, string>
    custom?: Record<string, unknown>
  }
}
