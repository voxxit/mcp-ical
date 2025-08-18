# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.3   | :white_check_mark: |
| 1.0.2   | :x:                |
| < 1.0.2 | :x:                |

## Security Fixes Changelog

### Version 1.0.3 (2025-08-18)

This release addresses multiple critical security vulnerabilities identified in v1.0.2. All users should upgrade immediately.

#### 🔴 Critical Fixes

##### 1. Command Injection Vulnerability

- **Location**: `src/timezone-date-manager.ts` (timezone detection and resolution)
- **Risk Level**: HIGH
- **Issue**: Arbitrary command execution through `execSync()` calls
- **Fix**:
  - Replaced `execSync('cat /etc/timezone')` with `fs.readFileSync('/etc/timezone')`
  - Replaced `execSync('readlink /etc/localtime')` with `fs.readlinkSync('/etc/localtime')`
  - Removed all shell command execution for timezone detection
  - Now uses Node.js native APIs exclusively for system information
  - The new Temporal-based `TimezoneDateManager` does not use shell commands, further hardening the security posture

##### 2. Server-Side Request Forgery (SSRF) Protection

- **Location**: `src/calendar-manager.ts:125-142`
- **Risk Level**: MEDIUM-HIGH
- **Issue**: Could fetch from internal networks, localhost, or cloud metadata endpoints
- **Fix**:
  - Added comprehensive URL validation in `validateCalendarUrl()`
  - Blocked requests to localhost (127.0.0.1, ::1, 0.0.0.0)
  - Blocked requests to private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  - Blocked requests to cloud metadata endpoints (169.254.169.254, metadata.google.internal)
  - Restricted to HTTPS/HTTP protocols only
  - Added IPv6 private range protection

#### 🟡 Medium Risk Fixes

##### 3. Input Validation & Sanitization

- **Issue**: Path traversal, injection attacks, resource exhaustion
- **Fixes**:
  - Added `validateCalendarName()` with strict alphanumeric + limited special chars validation
  - Implemented maximum length limits (calendar names: 100 chars, URLs: 2048 chars, search queries: 1000 chars)
  - Added path traversal prevention (`../` detection)
  - Implemented date range validation (max 1 year span)
  - Added bounds checking for all user inputs

##### 4. Resource Exhaustion Protection

- **Issue**: DoS through unlimited resource consumption
- **Fixes**:
  - Limited maximum calendar subscriptions to 10 per instance (configurable)
  - Implemented cache size limits (max 100 keys by default)
  - Added recursion depth limit for RRULE expansion (max 1000 occurrences)
  - Implemented processing timeout for RRULE operations (5 seconds)
  - Added content size limits for calendar fetches (10MB)
  - Enhanced cache configuration with automatic cleanup

##### 5. Error Handling & Information Disclosure

- **Issue**: Sensitive information leakage through error messages
- **Fixes**:
  - Added `sanitizeErrorMessage()` function
  - Removed stack traces from production error responses
  - Implemented structured logging with security context
  - Added production/development mode error handling
  - Masked sensitive URLs, IPs, and tokens in error messages

#### 🟢 Low Risk Fixes

##### 6. Security Configuration & Environment Validation

- **Additions**:
  - Created `SecurityConfigManager` class for centralized security configuration
  - Added environment variable validation on startup
  - Implemented secure defaults for all configurations
  - Added configurable security limits via environment variables
  - Enhanced production mode detection and warnings

## Security Features Added

### Environment Variables for Security Configuration

| Variable                     | Default | Min  | Max    | Description                    |
| ---------------------------- | ------- | ---- | ------ | ------------------------------ |
| `ICAL_MAX_CALENDARS`         | 10      | 1    | 50     | Maximum calendar subscriptions |
| `ICAL_MAX_CACHE_SIZE`        | 100     | 10   | 1000   | Maximum cache entries          |
| `ICAL_MAX_URL_LENGTH`        | 2048    | 100  | 4096   | Maximum URL length             |
| `ICAL_MAX_NAME_LENGTH`       | 100     | 1    | 200    | Maximum calendar name length   |
| `ICAL_MAX_QUERY_LENGTH`      | 1000    | 1    | 2000   | Maximum search query length    |
| `ICAL_MAX_DATE_RANGE_DAYS`   | 365     | 1    | 1095   | Maximum date range in days     |
| `ICAL_MAX_RRULE_OCCURRENCES` | 1000    | 1    | 5000   | Maximum RRULE occurrences      |
| `ICAL_RRULE_TIMEOUT_MS`      | 5000    | 1000 | 30000  | RRULE processing timeout       |
| `ICAL_FETCH_TIMEOUT_MS`      | 30000   | 5000 | 120000 | HTTP fetch timeout             |
| `ICAL_MAX_CONTENT_SIZE_MB`   | 10      | 1    | 100    | Maximum content size in MB     |

### Security Validations

1. **URL Validation**: Prevents SSRF attacks by blocking:
   - Private IP ranges (RFC 1918, RFC 4193)
   - Localhost addresses
   - Cloud metadata endpoints
   - Non-HTTP/HTTPS protocols

2. **Input Sanitization**: All user inputs are validated for:
   - Length limits
   - Character restrictions
   - Path traversal prevention
   - SQL injection prevention

3. **Resource Limits**: Prevents DoS attacks through:
   - Subscription limits
   - Cache size limits
   - Processing timeouts
   - Content size limits

4. **Error Sanitization**: Prevents information disclosure:
   - Generic error messages in production
   - Sensitive data masking
   - Stack trace removal

## Reporting a Vulnerability

If you discover a security vulnerability, please follow these steps:

1. **DO NOT** create a public GitHub issue
2. Email security concerns to: [security@srv.im]
3. Include a detailed description of the vulnerability
4. Provide steps to reproduce the issue
5. Include any proof-of-concept code

### What to Expect

- **Acknowledgment**: Within 24 hours
- **Initial Assessment**: Within 72 hours
- **Status Updates**: Weekly until resolved
- **Resolution Timeline**:
  - Critical: 24-48 hours
  - High: 1 week
  - Medium: 2-4 weeks
  - Low: 4-8 weeks

### Responsible Disclosure

We ask that you:

- Give us reasonable time to fix the issue before public disclosure
- Avoid accessing, modifying, or deleting data that doesn't belong to you
- Do not perform attacks that degrade the service for other users

## Security Best Practices for Users

1. **Environment Setup**:
   - Always set `NODE_ENV=production` in production environments
   - Configure appropriate security limits via environment variables
   - Use HTTPS URLs for calendar subscriptions when possible

2. **Network Security**:
   - Run the server behind a reverse proxy (nginx, Apache)
   - Implement additional rate limiting at the network level
   - Monitor for unusual traffic patterns

3. **Monitoring**:
   - Monitor logs for security warnings
   - Set up alerts for rate limit violations
   - Review subscription patterns regularly

## Security Architecture

### Defense in Depth

1. **Input Layer**: Comprehensive validation and sanitization
2. **Processing Layer**: Resource limits and timeouts
3. **Network Layer**: SSRF protection and protocol restrictions
4. **Output Layer**: Error sanitization and information disclosure prevention
5. **Configuration Layer**: Secure defaults and environment validation

### Security Boundaries

- **Untrusted Input**: All user-provided URLs, names, queries, and dates
- **Trusted Components**: Node.js native APIs, validated configuration
- **External Dependencies**: Calendar data from validated HTTPS sources only

## Compliance

This implementation follows security best practices from:

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Best Practices](https://docs.npmjs.com/packages-and-modules/securing-your-code)

## Acknowledgments

Security improvements in v1.0.3 were implemented to address findings from a comprehensive security audit. We thank the security research community for their continued efforts to improve software security.

---

**Last Updated**: 2025-08-18  
**Version**: 1.0.3  
**Security Contact**: security@srv.im
