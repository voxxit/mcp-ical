// Import temporal-polyfill first to ensure Temporal API is available for all tests
import "temporal-polyfill/global";

import { promises as fs } from "fs";
import path from "path";
import { CalendarManager } from "../calendar-manager";
import { SecurityConfigManager } from "../security-config";
import { TimezoneDateManager } from "../timezone-date-manager";

// Test isolation helpers
export function createTestCalendarManager(): CalendarManager {
  // Create a test-specific config path
  const testConfigPath = path.join(
    process.cwd(),
    `.test-ical-config-${Date.now()}-${Math.random()}.json`,
  );
  return new CalendarManager(testConfigPath);
}

/**
 * Remove in-memory state and on-disk test configuration created for a CalendarManager.
 *
 * If `calendarManager` is provided, its in-memory subscriptions and cache are cleared and its
 * associated config file (retrieved from `calendarManager.configPath`) is removed; missing files
 * are ignored. Independently, the current working directory is scanned for files whose names
 * start with ".test-ical-config-" and those files are deleted; individual deletion or directory
 * read errors are ignored to make cleanup best-effort for test isolation.
 *
 * @param calendarManager - Optional CalendarManager whose in-memory state and config file should be cleaned up.
 */
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

  // REMOVED: The global cleanup of all test config files that was causing race conditions
  // This was deleting config files from other running tests
}

/**
 * Reset singleton instances used by managers to ensure a clean state for tests.
 *
 * Clears the cached singleton instance on SecurityConfigManager so subsequent
 * code will create fresh instances. Intended for test isolation between test cases.
 */
export function resetSingletonState() {
  // Reset SecurityConfigManager singleton
  (SecurityConfigManager as any).instance = undefined;

  // Reset TimezoneDateManager is not a singleton, no cleanup needed
}

/**
 * Prepare an isolated test environment for CalendarManager-based tests.
 *
 * Resets global singleton state and creates a test-specific CalendarManager
 * backed by an ephemeral config path.
 *
 * @returns An object with `calendarManager` — a fresh CalendarManager instance
 * used for the isolated test environment.
 */
export function createIsolatedTestEnvironment() {
  // Reset singleton state before creating new instances
  resetSingletonState();

  // Create isolated calendar manager
  const calendarManager = createTestCalendarManager();

  return { calendarManager };
}

/**
 * Clean up a test CalendarManager's config/state and reset singleton managers.
 *
 * @param calendarManager - The test CalendarManager whose in-memory state and on-disk config should be removed.
 * @returns A promise that resolves when cleanup and singleton reset are complete.
 */
export async function cleanupIsolatedTestEnvironment(
  calendarManager: CalendarManager,
) {
  await cleanupTestConfig(calendarManager);
  resetSingletonState();
}

/**
 * Clean up any truly orphaned test config files.
 * This should only be called when no tests are running to avoid race conditions.
 * Meant for final cleanup after all tests complete.
 */
export async function cleanupOrphanedTestFiles() {
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
