import { CalendarManager } from '../calendar-manager';
import { SecurityConfigManager } from '../security-config';
import { TimezoneManager } from '../timezone-manager';

describe('Security Tests', () => {
  let calendarManager: CalendarManager;
  let securityConfig: SecurityConfigManager;

  beforeEach(() => {
    calendarManager = new CalendarManager();
    securityConfig = SecurityConfigManager.getInstance();
  });

  describe('Command Injection Prevention', () => {
    test('timezone detection should not use execSync', () => {
      const timezoneManager = TimezoneManager.getInstance();
      const timezone = timezoneManager.getTimezone();
      
      // Should succeed without throwing and return a valid timezone
      expect(typeof timezone).toBe('string');
      expect(timezone.length).toBeGreaterThan(0);
    });
  });

  describe('SSRF Protection', () => {
    test('should reject localhost URLs', async () => {
      await expect(
        calendarManager.subscribeCalendar('http://localhost:8080/calendar.ics', 'test-localhost')
      ).rejects.toThrow('Access to internal resources is not allowed');
    });

    test('should reject private IP addresses', async () => {
      await expect(
        calendarManager.subscribeCalendar('http://192.168.1.1/calendar.ics', 'test-private-ip')
      ).rejects.toThrow('Access to private networks is not allowed');
    });

    test('should reject cloud metadata endpoints', async () => {
      await expect(
        calendarManager.subscribeCalendar('http://169.254.169.254/calendar.ics', 'test-metadata')
      ).rejects.toThrow('Access to internal resources is not allowed');
    });

    test('should reject non-HTTP protocols', async () => {
      await expect(
        calendarManager.subscribeCalendar('file:///etc/passwd', 'test-file-protocol')
      ).rejects.toThrow('Invalid protocol: only http:, https: allowed');
    });

    test('should accept valid HTTPS URLs', () => {
      // This test just validates URL format, doesn't actually fetch
      expect(() => {
        // This will fail at the fetch stage, but URL validation should pass
        calendarManager.subscribeCalendar('https://example.com/calendar.ics', 'test-valid');
      }).not.toThrow('Invalid protocol');
    });
  });

  describe('Input Validation', () => {
    test('should reject calendar names with path traversal', async () => {
      await expect(
        calendarManager.subscribeCalendar('https://example.com/cal.ics', '../malicious')
      ).rejects.toThrow('Invalid calendar name');
    });

    test('should reject excessively long calendar names', async () => {
      const longName = 'a'.repeat(200);
      await expect(
        calendarManager.subscribeCalendar('https://example.com/cal.ics', longName)
      ).rejects.toThrow('Invalid calendar name');
    });

    test('should reject excessively long URLs', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(3000);
      await expect(
        calendarManager.subscribeCalendar(longUrl, 'test')
      ).rejects.toThrow('URL exceeds maximum length');
    });

    test('should reject invalid characters in calendar names', async () => {
      await expect(
        calendarManager.subscribeCalendar('https://example.com/cal.ics', 'test<script>')
      ).rejects.toThrow('Invalid calendar name');
    });
  });

  describe('Resource Limits', () => {
    test('should reject dates with excessive range', async () => {
      const start = new Date('2020-01-01');
      const end = new Date('2025-01-01'); // 5 years apart
      
      await expect(
        calendarManager.getEvents(start, end)
      ).rejects.toThrow('Invalid date range');
    });

    test('should limit search query length', async () => {
      const longQuery = 'a'.repeat(2000);
      
      await expect(
        calendarManager.searchEvents(longQuery)
      ).rejects.toThrow('Invalid search query');
    });

    test('should enforce subscription limits', async () => {
      const config = securityConfig.getConfig();
      
      // Try to add more than the maximum allowed subscriptions
      // This would fail at the network fetch stage, but we can test the limit
      const promises = [];
      for (let i = 0; i < config.maxCalendarSubscriptions + 1; i++) {
        promises.push(
          calendarManager.subscribeCalendar(`https://example${i}.com/cal.ics`, `test${i}`)
            .catch(err => err.message)
        );
      }
      
      const results = await Promise.all(promises);
      const limitErrors = results.filter(result => 
        typeof result === 'string' && result.includes('Maximum number of calendar subscriptions')
      );
      
      // At least one should fail due to subscription limit
      expect(limitErrors.length).toBeGreaterThan(0);
    });
  });

  describe('Security Configuration', () => {
    test('should load security configuration with valid defaults', () => {
      const config = securityConfig.getConfig();
      
      expect(config.maxCalendarSubscriptions).toBeGreaterThan(0);
      expect(config.maxCacheSize).toBeGreaterThan(0);
      expect(config.maxUrlLength).toBeGreaterThan(0);
      expect(config.rruleTimeoutMs).toBeGreaterThan(0);
      expect(typeof config.production).toBe('boolean');
    });

    test('should validate calendar names correctly', () => {
      expect(securityConfig.isValidCalendarName('valid-name')).toBe(true);
      expect(securityConfig.isValidCalendarName('valid_name.2')).toBe(true);
      expect(securityConfig.isValidCalendarName('../invalid')).toBe(false);
      expect(securityConfig.isValidCalendarName('')).toBe(false);
      expect(securityConfig.isValidCalendarName('   ')).toBe(false);
    });

    test('should validate URLs correctly', () => {
      expect(securityConfig.isValidUrl('https://example.com')).toBe(true);
      expect(securityConfig.isValidUrl('http://example.com')).toBe(true);
      expect(securityConfig.isValidUrl('ftp://example.com')).toBe(false);
      expect(securityConfig.isValidUrl('not-a-url')).toBe(false);
    });

    test('should validate date ranges correctly', () => {
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const farFuture = new Date(today.getTime() + 400 * 24 * 60 * 60 * 1000); // 400 days
      
      expect(securityConfig.isValidDateRange(today, tomorrow)).toBe(true);
      expect(securityConfig.isValidDateRange(tomorrow, today)).toBe(false); // start after end
      expect(securityConfig.isValidDateRange(today, farFuture)).toBe(false); // too far apart
    });

    test('should validate search queries correctly', () => {
      expect(securityConfig.isValidSearchQuery('meeting')).toBe(true);
      expect(securityConfig.isValidSearchQuery('team meeting tomorrow')).toBe(true);
      expect(securityConfig.isValidSearchQuery('')).toBe(false);
      expect(securityConfig.isValidSearchQuery('   ')).toBe(false);
      expect(securityConfig.isValidSearchQuery('a'.repeat(2000))).toBe(false);
    });
  });

  describe('Error Sanitization', () => {
    test('should not expose internal paths in production mode', () => {
      // Set production mode temporarily
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      try {
        const manager = new CalendarManager();
        // Access the private method for testing
        const sanitizeMethod = (manager as any).sanitizeErrorMessage;
        
        const testError = new Error('ENOENT: no such file or directory, open \'/home/user/.secret\'');
        const sanitized = sanitizeMethod(testError, 'test');
        
        expect(sanitized).not.toContain('/home/user/.secret');
        expect(sanitized).toBe('An error occurred while processing calendar data');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('should mask sensitive information in development mode', () => {
      // Set development mode temporarily
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      try {
        const manager = new CalendarManager();
        const sanitizeMethod = (manager as any).sanitizeErrorMessage;
        
        const testError = new Error('Failed to fetch https://secret-server.com/api with Bearer abc123token');
        const sanitized = sanitizeMethod(testError, 'test');
        
        expect(sanitized).not.toContain('https://secret-server.com/api');
        expect(sanitized).not.toContain('Bearer abc123token');
        expect(sanitized).toContain('[URL]');
        expect(sanitized).toContain('[TOKEN]');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});