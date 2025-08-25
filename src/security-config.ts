/**
 * Security configuration and environment validation utilities
 */

export interface SecurityConfig {
	maxCalendarSubscriptions: number;
	maxCacheSize: number;
	maxUrlLength: number;
	maxCalendarNameLength: number;
	maxSearchQueryLength: number;
	maxDateRangeDays: number;
	maxRRuleOccurrences: number;
	rruleTimeoutMs: number;
	fetchTimeoutMs: number;
	maxContentSizeBytes: number;
	production: boolean;
}

export class SecurityConfigManager {
	private static instance: SecurityConfigManager;
	private config: SecurityConfig;

	private constructor() {
		this.config = this.loadSecureDefaults();
		this.validateEnvironment();
	}

	static getInstance(): SecurityConfigManager {
		if (!SecurityConfigManager.instance) {
			SecurityConfigManager.instance = new SecurityConfigManager();
		}
		return SecurityConfigManager.instance;
	}

	private loadSecureDefaults(): SecurityConfig {
		return {
			maxCalendarSubscriptions: this.getEnvNumber(
				"ICAL_MAX_CALENDARS",
				10,
				1,
				50,
			),
			maxCacheSize: this.getEnvNumber("ICAL_MAX_CACHE_SIZE", 100, 10, 1000),
			maxUrlLength: this.getEnvNumber("ICAL_MAX_URL_LENGTH", 2048, 100, 4096),
			maxCalendarNameLength: this.getEnvNumber(
				"ICAL_MAX_NAME_LENGTH",
				100,
				1,
				200,
			),
			maxSearchQueryLength: this.getEnvNumber(
				"ICAL_MAX_QUERY_LENGTH",
				1000,
				1,
				2000,
			),
			maxDateRangeDays: this.getEnvNumber(
				"ICAL_MAX_DATE_RANGE_DAYS",
				365,
				1,
				1095,
			), // Max 3 years
			maxRRuleOccurrences: this.getEnvNumber(
				"ICAL_MAX_RRULE_OCCURRENCES",
				1000,
				1,
				5000,
			),
			rruleTimeoutMs: this.getEnvNumber(
				"ICAL_RRULE_TIMEOUT_MS",
				5000,
				1000,
				30000,
			),
			fetchTimeoutMs: this.getEnvNumber(
				"ICAL_FETCH_TIMEOUT_MS",
				30000,
				5000,
				120000,
			),
			maxContentSizeBytes:
				this.getEnvNumber("ICAL_MAX_CONTENT_SIZE_MB", 10, 1, 100) * 1024 * 1024,
			production: process.env.NODE_ENV === "production",
		};
	}

	private getEnvNumber(
		envVar: string,
		defaultValue: number,
		min: number,
		max: number,
	): number {
		const value = process.env[envVar];
		if (!value) {
			return defaultValue;
		}

		const parsed = parseInt(value, 10);
		if (isNaN(parsed)) {
			console.warn(
				`Warning: Invalid value for ${envVar}: "${value}". Using default: ${defaultValue}`,
			);
			return defaultValue;
		}

		if (parsed < min || parsed > max) {
			console.warn(
				`Warning: Value for ${envVar} (${parsed}) outside safe range [${min}, ${max}]. Using default: ${defaultValue}`,
			);
			return defaultValue;
		}

		return parsed;
	}

	private validateEnvironment(): void {
		const requiredEnvVars: string[] = [];
		const missingVars: string[] = [];

		for (const envVar of requiredEnvVars) {
			if (!process.env[envVar]) {
				missingVars.push(envVar);
			}
		}

		if (missingVars.length > 0) {
			console.warn(
				`Warning: Missing environment variables: ${missingVars.join(", ")}`,
			);
		}

		// Validate TZ if set
		if (process.env.TZ) {
			try {
				// Test if timezone is valid
				new Intl.DateTimeFormat("en-US", { timeZone: process.env.TZ });
			} catch (_error) {
				console.warn(
					`Warning: Invalid timezone in TZ environment variable: ${process.env.TZ}`,
				);
			}
		}

		// Security warnings for development (but not in tests)
		if (!this.config.production && process.env.NODE_ENV !== "test") {
			console.warn(
				"⚠️ Running in development mode - verbose error messages enabled",
			);
		}
	}

	getConfig(): SecurityConfig {
		return { ...this.config };
	}

	isValidCalendarName(name: string): boolean {
		if (!name || typeof name !== "string") {
			return false;
		}

		if (name.length > this.config.maxCalendarNameLength) {
			return false;
		}

		// Allow alphanumeric chars, spaces, hyphens, underscores, and dots
		const validNamePattern = /^[a-zA-Z0-9\s\-_.]+$/;
		if (!validNamePattern.test(name)) {
			return false;
		}

		// Prevent path traversal
		if (name.includes("..") || name.includes("/") || name.includes("\\")) {
			return false;
		}

		// Prevent names that are just whitespace
		if (name.trim().length === 0) {
			return false;
		}

		return true;
	}

	isValidUrl(url: string): boolean {
		if (!url || typeof url !== "string") {
			return false;
		}

		if (url.length > this.config.maxUrlLength) {
			return false;
		}

		try {
			const parsed = new URL(url);

			// Only allow HTTP and HTTPS protocols
			const allowedProtocols = ["http:", "https:"];
			if (!allowedProtocols.includes(parsed.protocol)) {
				return false;
			}

			return true;
		} catch {
			return false;
		}
	}

	isValidDateRange(startDate: Date, endDate: Date): boolean {
		if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
			return false;
		}

		if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
			return false;
		}

		if (startDate >= endDate) {
			return false;
		}

		// Check maximum date range
		const daysDiff =
			(endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
		if (daysDiff > this.config.maxDateRangeDays) {
			return false;
		}

		return true;
	}

	isValidSearchQuery(query: string): boolean {
		if (!query || typeof query !== "string") {
			return false;
		}

		if (query.length > this.config.maxSearchQueryLength) {
			return false;
		}

		if (query.trim().length === 0) {
			return false;
		}

		return true;
	}
}
