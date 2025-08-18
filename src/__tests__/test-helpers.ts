import { CalendarManager } from "../calendar-manager";
import { SecurityConfigManager } from "../security-config";
import { TimezoneManager } from "../timezone-manager";
import path from "path";
import { promises as fs } from "fs";

// Test isolation helpers
export function createTestCalendarManager(): CalendarManager {
  // Create a test-specific config path
  const testConfigPath = path.join(
    process.cwd(),
    `.test-ical-config-${Date.now()}-${Math.random()}.json`,
  );
  return new CalendarManager(testConfigPath);
}

export async function cleanupTestConfig(calendarManager?: CalendarManager) {
  if (calendarManager) {
    // Clear in-memory subscriptions
    (calendarManager as any).subscriptions.clear();

    // Clear cache
    (calendarManager as any).cache.flushAll();

    const configPath = (calendarManager as any).configPath;
    try {
      await fs.unlink(configPath);
    } catch (_error) {
      // File doesn't exist, that's fine
    }
  }

  // Also clean up any leftover test config files
  try {
    const files = await fs.readdir(process.cwd());
    const testFiles = files.filter((file) =>
      file.startsWith(".test-ical-config-"),
    );
    await Promise.all(
      testFiles.map((file) =>
        fs.unlink(path.join(process.cwd(), file)).catch(() => {}),
      ),
    );
  } catch (_error) {
    // Directory read failed, ignore
  }
}

// Reset singleton state for test isolation
export function resetSingletonState() {
  // Reset SecurityConfigManager singleton
  (SecurityConfigManager as any).instance = undefined;

  // Reset TimezoneManager singleton to clear cached timezone
  (TimezoneManager as any).instance = undefined;
}

// Helper to create isolated test environment
export function createIsolatedTestEnvironment() {
  // Reset singleton state before creating new instances
  resetSingletonState();

  // Create isolated calendar manager
  const calendarManager = createTestCalendarManager();

  return { calendarManager };
}

// Helper to cleanup isolated test environment
export async function cleanupIsolatedTestEnvironment(
  calendarManager: CalendarManager,
) {
  await cleanupTestConfig(calendarManager);
  resetSingletonState();
}
