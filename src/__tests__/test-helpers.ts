import { CalendarManager } from "../calendar-manager";
import path from "path";
import { promises as fs } from "fs";

// Override config path for tests
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
