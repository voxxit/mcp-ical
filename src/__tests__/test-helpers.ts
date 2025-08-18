import { CalendarManager } from "../calendar-manager";
import path from "path";
import { promises as fs } from "fs";

// Override config path for tests
export function createTestCalendarManager(): CalendarManager {
  const manager = new CalendarManager();
  // Override the config path to use a test-specific location
  (manager as any).configPath = path.join(
    process.cwd(),
    ".test-ical-config.json",
  );
  return manager;
}

export async function cleanupTestConfig() {
  const testConfigPath = path.join(process.cwd(), ".test-ical-config.json");
  try {
    await fs.unlink(testConfigPath);
  } catch (_error) {
    // File doesn't exist, that's fine
  }
}
