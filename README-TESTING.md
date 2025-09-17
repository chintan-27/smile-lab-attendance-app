# Testing Guide for UF Lab Attendance System

This guide explains how to run and maintain the automated tests for the **UF Lab Attendance System**. The suite covers **unit**, **integration**, and **end-to-end (E2E)** tests using **Jest** and **Playwright (Electron)**.

## Folder Structure

```
UF-Lab-Attendance-System/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── helpers/
│   ├── fixtures/
│   └── setup/
├── package.json
└── README-TESTING.md
```

### What each folder is for

* `tests/unit/` – Pure logic with no I/O or UI; fast feedback.
* `tests/integration/` – Multiple modules working together (e.g., DataManager + persistence).
* `tests/e2e/` – Black-box UI tests through Electron with Playwright.
* `tests/helpers/` – Reusable test utilities and data generators.
* `tests/fixtures/` – Static JSON files used by tests.
* `tests/setup/` – Jest config, environment bootstrap, and teardown scripts.

---

## Prerequisites

* Node.js 18+ and npm
* macOS, Linux, or Windows
* For E2E tests: ability to launch an Electron window (CI runners may require xvfb on Linux).

---

## Install Dependencies

```bash
npm install --save-dev jest electron @testing-library/jest-dom jest-environment-jsdom @playwright/test
```

---

## Running Tests

### Run all tests

```bash
npm test
```

### Run a specific suite

```bash
npm run test:unit
npm run test:integration
npm run test:e2e   # runs Playwright
```

### Watch mode (useful during development)

```bash
npm run test:watch
```

### Coverage report

```bash
npm run test:coverage
```

Coverage is written to the `coverage/` folder and includes `text`, `lcov`, and `html` reports.

---

## Configuration Details

* **Primary config** lives in `package.json` under the `jest` field.
* A secondary, explicit Jest config is also included at `tests/setup/jest.config.js` and is useful for editor tooling or direct jest invocations:

  * `testEnvironment: "node"`
  * `setupFilesAfterEnv: ["<rootDir>/tests/setup/setupTests.js"]`
  * `testTimeout: 30000`
  * coverage reporters: `text`, `lcov`, `html`
  * mocks and timers are cleared/reset/restored between tests

### Setup & Teardown

* `tests/setup/setupTests.js` bootstraps a clean test data directory and **mocks Electron** so unit/integration tests can run without launching a real app window.
* `tests/setup/teardown.js` removes temporary test data after the run.

---

## End-to-End (Playwright) Notes

* E2E tests use Playwright’s Electron driver (`_electron`) to launch the app and interact with the UI.
* Ensure your app can boot in a minimal test mode with environment variable `NODE_ENV=test`.
* In CI on Linux, run under a virtual display:

  ```bash
  xvfb-run -a npm run test:e2e
  ```

---

## Writing Tests

### Conventions

* Test files end with `.test.js` for unit/integration and `.spec.ts|js` for Playwright E2E tests.
* Keep unit tests fast and deterministic—no real I/O or timers.
* Prefer helpers from `tests/helpers/testUtils.js` for file I/O within the sandboxed `test-data/` folder.
* Use fixtures from `tests/fixtures/` for canonical sample datasets.

### Example Patterns

* **Unit**: validate `DataManager` methods (`addStudent`, `getStats`, etc.).
* **Integration**: simulate a “day in the lab” workflow from student add → sign-in → sign-out → reporting.
* **E2E**: verify UI loads, inputs validate UFIDs, admin modal auth flow, responsive behavior.

---

## Troubleshooting

* **Electron fails to start**: ensure your local environment can open a window; try `xvfb-run` on headless Linux.
* **Module not found (`data.js`)**: tests reference `../../data.js`. If running tests standalone, provide your app’s `data.js` module or adjust import paths.
* **Port conflicts**: make sure no other test run is holding OS resources.
* **Flaky timing**: prefer `await testUtils.waitFor(ms)` over arbitrary `setTimeout` in tests.

---

## Continuous Integration (optional)

Example GitHub Actions workflow:

```yaml
name: tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: xvfb-run -a npm test
```

---

## Maintaining Fixtures

* `sample-students.json` and `sample-attendance.json` are small but representative datasets.
* Update them when the app’s schema changes. Keep timestamps ISO-8601.

---

## Tips

* Keep mocks near where they’re used; global Electron mocks live in setup.
* Use `test:verbose` to quickly find slow or failing specs.
* Prefer **small, focused** tests; add E2E only for top-value user flows.

---

## Migration Notes (from Spectron)

* Spectron was removed. Tests now use `@playwright/test` with the Electron driver (`_electron`).
* New config: `tests/e2e/playwright.config.ts`
* E2E command: `npm run test:e2e` (runs Playwright)
* API mapping examples:

  * `app.client.getTitle()` → `expect(page).toHaveTitle()`
  * `$(selector)` → `page.locator(selector)`
  * `isDisplayed/isEnabled` → `toBeVisible()/toBeEnabled()`
  * `browserWindow.setSize(w,h)` → `page.setViewportSize({ width, height })`

---
