import { execSync } from 'child_process';

export class TimezoneManager {
  private static instance: TimezoneManager;
  private timezone: string;

  private constructor() {
    // Check TZ environment variable first (UNIX standard)
    if (process.env.TZ) {
      this.timezone = process.env.TZ;
      if (process.env.NODE_ENV !== 'test') {
        console.error(`Using timezone from TZ environment variable: ${this.timezone}`);
      }
    } else {
      // Try to detect system timezone
      this.timezone = this.detectSystemTimezone();
      if (process.env.NODE_ENV !== 'test') {
        console.error(`Detected system timezone: ${this.timezone}`);
      }
    }
  }

  static getInstance(): TimezoneManager {
    if (!TimezoneManager.instance) {
      TimezoneManager.instance = new TimezoneManager();
    }
    return TimezoneManager.instance;
  }

  private detectSystemTimezone(): string {
    try {
      // Try different methods to detect timezone
      
      // Method 1: Use Intl API (works in Node.js)
      const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detectedTz) {
        return detectedTz;
      }
    } catch (error) {
      // Intl API failed
    }

    try {
      // Method 2: Check /etc/timezone (Linux)
      const timezone = execSync('cat /etc/timezone 2>/dev/null', { encoding: 'utf8' }).trim();
      if (timezone) {
        return timezone;
      }
    } catch (error) {
      // Not Linux or file doesn't exist
    }

    try {
      // Method 3: Check /etc/localtime symlink (Linux/Unix)
      const localtime = execSync('readlink /etc/localtime 2>/dev/null', { encoding: 'utf8' }).trim();
      if (localtime) {
        // Extract timezone from path like /usr/share/zoneinfo/America/New_York
        const match = localtime.match(/zoneinfo\/(.+)$/);
        if (match) {
          return match[1];
        }
      }
    } catch (error) {
      // Not Unix or symlink doesn't exist
    }

    try {
      // Method 4: macOS specific
      const timezone = execSync('defaults read /Library/Preferences/.GlobalPreferences.plist com.apple.timezone.auto.plist 2>/dev/null | grep timezone | cut -d\\" -f2', { encoding: 'utf8' }).trim();
      if (timezone) {
        return timezone;
      }
    } catch (error) {
      // Not macOS
    }

    try {
      // Method 5: Use date command (cross-platform fallback)
      const dateOutput = execSync('date +%Z', { encoding: 'utf8' }).trim();
      // This gives abbreviated timezone like PST, EST, etc.
      // Try to map to IANA timezone
      const tzMap: { [key: string]: string } = {
        'PST': 'America/Los_Angeles',
        'PDT': 'America/Los_Angeles',
        'MST': 'America/Denver',
        'MDT': 'America/Denver',
        'CST': 'America/Chicago',
        'CDT': 'America/Chicago',
        'EST': 'America/New_York',
        'EDT': 'America/New_York',
        'GMT': 'Europe/London',
        'BST': 'Europe/London',
        'CET': 'Europe/Paris',
        'CEST': 'Europe/Paris',
      };
      
      if (tzMap[dateOutput]) {
        return tzMap[dateOutput];
      }
    } catch (error) {
      // date command failed
    }

    // Default fallback
    console.error('Warning: Could not detect timezone, defaulting to UTC');
    return 'UTC';
  }

  getTimezone(): string {
    return this.timezone;
  }

  /**
   * Convert a date to the server's timezone
   */
  toLocalDate(date: Date | string): Date {
    if (typeof date === 'string') {
      date = new Date(date);
    }
    
    // If we're already in the correct timezone, return as-is
    if (this.timezone === 'UTC') {
      return date;
    }

    // Create a date in the target timezone
    const localDateStr = date.toLocaleString('en-US', { timeZone: this.timezone });
    return new Date(localDateStr);
  }

  /**
   * Get start of day in the server's timezone
   */
  getStartOfDay(date: Date | string): Date {
    const localDate = this.toLocalDate(date);
    const startOfDay = new Date(localDate);
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay;
  }

  /**
   * Get end of day in the server's timezone
   */
  getEndOfDay(date: Date | string): Date {
    const localDate = this.toLocalDate(date);
    const endOfDay = new Date(localDate);
    endOfDay.setHours(23, 59, 59, 999);
    return endOfDay;
  }

  /**
   * Format a date in the server's timezone
   */
  formatDate(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
    if (typeof date === 'string') {
      date = new Date(date);
    }
    
    return date.toLocaleString('en-US', {
      timeZone: this.timezone,
      ...options
    });
  }

  /**
   * Get the current date/time in the server's timezone
   */
  getCurrentDateTime(): Date {
    return this.toLocalDate(new Date());
  }
}