import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chromium } from "playwright-core";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  activateChatGptEffortMenu,
  assertTemporaryChatPage,
  chatGptEffortMenuForControl,
  chatGptEffortSlider,
  detectChatGptAccountCapabilities,
  type ChatGptEffortActivation,
} from "../../open-sse/vendor/codex-chatgpt-web/chatgpt-session.ts";

describe("ChatGPT Web Effort Menu & Capabilities Contract", () => {
  describe("Selector contracts", () => {
    it("exports selectors matching ChatGPT DOM surfaces", () => {
      assert.ok(CHATGPT_EFFORT_CONTROL_SELECTOR.includes('data-tone="neutral"'));
      assert.ok(
        CHATGPT_EFFORT_CONTROL_SELECTOR.includes('data-testid="model-switcher-dropdown-button"')
      );
      assert.ok(CHATGPT_COMPOSER_SELECTOR.includes('data-testid="prompt-textarea"'));
      assert.ok(CHATGPT_EFFORT_MENU_SELECTOR.includes("composer-intelligence-picker-content"));
      assert.equal(
        CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
        "[data-model-reasoning-effort-slider]"
      );
    });
  });
  describe("chatGptEffortMenuForControl (aria-controls ownership)", () => {
    it("binds the owned menu by ID when aria-controls is present", async () => {
      const control = {
        getAttribute: async (name: string) =>
          name === "aria-controls" ? "radix-custom-effort-menu-id" : null,
      };
      const requestedSelectors: string[] = [];
      const page = {
        locator: (selector: string) => {
          requestedSelectors.push(selector);
          return { id: "owned-menu-locator", selector };
        },
      };

      const menu = await chatGptEffortMenuForControl(page as never, control as never);
      assert.deepEqual(requestedSelectors, ['[id="radix-custom-effort-menu-id"]']);
      assert.equal((menu as unknown as { id: string }).id, "owned-menu-locator");
    });

    it("falls back to visible CHATGPT_EFFORT_MENU_SELECTOR when aria-controls is absent", async () => {
      const control = {
        getAttribute: async () => null,
      };
      const filters: unknown[] = [];
      let lastCalled = false;
      const locatorObj = {
        filter(opts: unknown) {
          filters.push(opts);
          return this;
        },
        last() {
          lastCalled = true;
          return this;
        },
      };
      let capturedSelector = "";
      const page = {
        locator: (selector: string) => {
          capturedSelector = selector;
          return locatorObj;
        },
      };

      const menu = await chatGptEffortMenuForControl(page as never, control as never);
      assert.equal(capturedSelector, CHATGPT_EFFORT_MENU_SELECTOR);
      assert.deepEqual(filters, [{ visible: true }]);
      assert.equal(lastCalled, true);
      assert.equal(menu, locatorObj as never);
    });
  });

  describe("chatGptEffortSlider", () => {
    it("filters slider container by visibility and scopes slider locator within container", () => {
      let filterOpts: unknown = null;
      let lastCalled = false;
      let scopedChildSelector = "";
      const childLocator = { role: "slider-locator" };
      const containerLocator = {
        filter(opts: unknown) {
          filterOpts = opts;
          return this;
        },
        last() {
          lastCalled = true;
          return this;
        },
        locator(subSelector: string) {
          scopedChildSelector = subSelector;
          return childLocator;
        },
      };

      const page = {
        locator(selector: string) {
          assert.equal(selector, CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR);
          return containerLocator;
        },
      };

      const result = chatGptEffortSlider(page as never);
      assert.deepEqual(filterOpts, { visible: true });
      assert.equal(lastCalled, true);
      assert.equal(scopedChildSelector, '[role="slider"]');
      assert.equal(result.slider, childLocator as never);
    });
  });

  describe("activateChatGptEffortMenu", () => {
    it("returns immediately with already-open when surface is already visible", async () => {
      const control = {
        getAttribute: async (name: string) => {
          if (name === "aria-controls") return "effort-menu-1";
          if (name === "aria-expanded") return "true";
          if (name === "data-state") return "open";
          return null;
        },
      };
      const ownedMenu = { isVisible: async () => true };
      const slider = { isVisible: async () => false };
      const sliderContainer = {
        filter() {
          return this;
        },
        last() {
          return this;
        },
        locator: () => slider,
        isVisible: async () => true,
      };
      const page = {
        locator: (sel: string) => {
          if (sel === '[id="effort-menu-1"]') return ownedMenu;
          if (sel === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return sliderContainer;
          return { isVisible: async () => false };
        },
        keyboard: { press: async () => {} },
      };

      const activation: ChatGptEffortActivation = await activateChatGptEffortMenu(
        page as never,
        control as never,
        {
          settleMs: 10,
        }
      );
      assert.equal(activation.method, "already-open");
      assert.equal(activation.menu, ownedMenu as never);
      assert.equal(activation.sliderContainer, sliderContainer as never);
    });

    it("does not bind a closing menu when aria-expanded is false or data-state is closed", async () => {
      for (const attribute of ["aria-expanded", "data-state"]) {
        let opened = false;
        let clicks = 0;
        const surface = {
          filter() {
            return this;
          },
          last() {
            return this;
          },
          locator() {
            return this;
          },
          isVisible: async () => true,
        };
        const control = {
          getAttribute: async (name: string) => {
            if (name === attribute) {
              return attribute === "aria-expanded" ? String(opened) : opened ? "open" : "closed";
            }
            return null;
          },
          click: async () => {
            clicks++;
            opened = true;
          },
        };
        const page = {
          locator: () => surface,
          keyboard: { press: async () => {} },
        };

        const activation = await activateChatGptEffortMenu(page as never, control as never, {
          settleMs: 50,
        });
        assert.equal(activation.method, "click");
        assert.equal(clicks, 1);
      }
    });

    it("click-success-but-no-menu fallback: retries ghost click with primary pointerdown", async () => {
      let ghostOpen = false;
      let pointerOpened = false;
      const events: unknown[] = [];
      const ownedMenu = { isVisible: async () => pointerOpened };
      const hiddenSurface = {
        filter() {
          return this;
        },
        last() {
          return this;
        },
        locator() {
          return this;
        },
        isVisible: async () => false,
      };
      const control = {
        getAttribute: async (name: string) => {
          if (name === "aria-controls") return pointerOpened ? "radix-effort-menu" : null;
          if (name === "aria-expanded") return ghostOpen ? "true" : "false";
          if (name === "data-state") return ghostOpen ? "open" : "closed";
          return null;
        },
        click: async (options: unknown) => {
          events.push(["click", options]);
          ghostOpen = true; // Click succeeded, but menu never became visible
        },
        dispatchEvent: async (name: string, detail: unknown) => {
          events.push([name, detail]);
          ghostOpen = true;
          pointerOpened = true; // Pointerdown successfully opens the menu
        },
      };
      const page = {
        locator: (selector: string) => {
          if (selector === '[id="radix-effort-menu"]') return ownedMenu;
          return hiddenSurface;
        },
        keyboard: {
          press: async (key: string) => {
            events.push(["keyboard", key]);
            ghostOpen = false; // Escape clears ghost open state
          },
        },
      };

      const activation: ChatGptEffortActivation = await activateChatGptEffortMenu(
        page as never,
        control as never,
        {
          settleMs: 10,
        }
      );
      assert.equal(activation.method, "pointerdown");
      assert.equal(activation.menu, ownedMenu as never);
      assert.deepEqual(events, [
        ["click", { force: true, timeout: 10 }],
        ["keyboard", "Escape"],
        [
          "pointerdown",
          {
            button: 0,
            buttons: 1,
            pointerType: "mouse",
            isPrimary: true,
          },
        ],
      ]);
    });

    it("fails closed when neither click nor pointerdown exposes a structural surface", async () => {
      const hiddenSurface = {
        filter() {
          return this;
        },
        last() {
          return this;
        },
        locator() {
          return this;
        },
        isVisible: async () => false,
      };
      const control = {
        getAttribute: async () => null,
        click: async () => {},
        dispatchEvent: async () => {},
      };
      const page = {
        locator: () => hiddenSurface,
        keyboard: { press: async () => {} },
      };

      await assert.rejects(
        async () => {
          await activateChatGptEffortMenu(page as never, control as never, { settleMs: 10 });
        },
        {
          message:
            "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown",
        }
      );
    });
  });

  describe("detectChatGptAccountCapabilities (no radio-only inference & bounded waits)", () => {
    function createCapabilitiesFixture(
      options: {
        max?: string;
        missingSlider?: boolean;
        noEffortButton?: boolean;
      } = {}
    ) {
      let value = 0;
      const slider = {
        isVisible: async () => false, // Semantic zero-width input is aria-hidden
        waitFor: async ({ state }: { state: string }) => {
          assert.equal(state, "attached");
        },
        getAttribute: async (name: string) =>
          ({
            "aria-valuemin": "0",
            "aria-valuemax": options.max ?? "4",
            "aria-valuenow": String(value),
            "aria-hidden": "true",
          })[name] ?? null,
      };
      const container = {
        filter() {
          return this;
        },
        last() {
          return this;
        },
        locator: () => slider,
        isVisible: async () => !options.missingSlider,
        waitFor: async ({ state }: { state: string }) => {
          assert.equal(state, "visible");
          if (options.missingSlider) {
            throw new Error("effort container never hydrated");
          }
        },
      };
      const control = {
        last() {
          return this;
        },
        waitFor: async () => {},
        isVisible: async () => !options.noEffortButton,
        getAttribute: async (name: string) => (name === "aria-expanded" ? "true" : null),
        press: async () => {},
      };
      const composerForm = {
        locator: () => control,
        count: async () => 1,
      };
      const composer = {
        filter() {
          return this;
        },
        last() {
          return this;
        },
        locator: () => composerForm,
        count: async () => 1,
      };
      // Model radio rows present, simulating hydrated model picker
      const modelRows = {
        count: async () => 3,
        first() {
          return this;
        },
        waitFor: async () => {},
        nth: () => {
          throw new Error("Model rows are not effort choices");
        },
      };
      const menu = {
        filter() {
          return this;
        },
        last() {
          return this;
        },
        isVisible: async () => true,
        locator: () => modelRows,
      };
      const page = {
        locator: (selector: string) => {
          if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
          if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
          if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return container;
          return { isVisible: async () => false, count: async () => 0 };
        },
        keyboard: { press: async () => {} },
        evaluate: async () => true,
      };

      return { page };
    }

    it("evaluates 5-step range as Pro ({ solAvailable: true, proAvailable: true })", async () => {
      const fixture = createCapabilitiesFixture({ max: "4" });
      const caps = await detectChatGptAccountCapabilities(fixture.page as never, {
        selectorTimeoutMs: 100,
        stableAbsenceMs: 50,
      });
      assert.deepEqual(caps, { solAvailable: true, proAvailable: true });
    });

    it("evaluates 3-step range as non-Pro ({ solAvailable: true, proAvailable: false })", async () => {
      const fixture = createCapabilitiesFixture({ max: "2" });
      const caps = await detectChatGptAccountCapabilities(fixture.page as never, {
        selectorTimeoutMs: 100,
        stableAbsenceMs: 50,
      });
      assert.deepEqual(caps, { solAvailable: true, proAvailable: false });
    });

    it("fails closed when effort slider is absent, never inferring capabilities from radio rows", async () => {
      const fixture = createCapabilitiesFixture({ missingSlider: true });
      await assert.rejects(
        async () => {
          await detectChatGptAccountCapabilities(fixture.page as never, {
            selectorTimeoutMs: 100,
            stableAbsenceMs: 50,
          });
        },
        {
          message: "effort container never hydrated",
        }
      );
    });

    it("fails closed with actionable error on malformed ARIA range", async () => {
      const fixture = createCapabilitiesFixture({ max: "invalid" });
      await assert.rejects(
        async () => {
          await detectChatGptAccountCapabilities(fixture.page as never, {
            selectorTimeoutMs: 100,
            stableAbsenceMs: 50,
          });
        },
        (err: Error) => {
          assert.match(err.message, /ChatGPT model controls are unavailable/);
          return true;
        }
      );
    });
  });

  describe("assertTemporaryChatPage (OmniRoute temporary chat security)", () => {
    it("accepts canonical temporary chat URL", async () => {
      const page = { url: () => CHATGPT_TEMPORARY_CHAT_URL };
      await assert.doesNotReject(async () => {
        await assertTemporaryChatPage(page as never);
      });
    });

    it("rejects non-temporary chat URLs", async () => {
      const invalidUrls = [
        "https://chatgpt.com/",
        "https://chatgpt.com/?temporary-chat=false",
        "https://chatgpt.com/g/g-someid",
        "https://malicious-chatgpt.com/?temporary-chat=true",
        "https://chatgpt.com/c/conversation-id?temporary-chat=true",
      ];
      for (const url of invalidUrls) {
        const page = { url: () => url };
        await assert.rejects(async () => {
          await assertTemporaryChatPage(page as never);
        }, /ChatGPT left the isolated Temporary Chat surface/);
      }
    });
  });

  describe("Playwright DOM fixture verification", () => {
    it("verifies real DOM locator resolution and aria-controls ownership", async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <form>
            <button id="effort-btn" aria-haspopup="menu" aria-controls="real-owned-menu">Effort</button>
          </form>
          <div id="real-owned-menu" role="menu" style="display: none;">
            <div data-model-reasoning-effort-slider>
              <span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span>
            </div>
          </div>
        `);
        const control = page.locator("#effort-btn");
        const menu = await chatGptEffortMenuForControl(page, control);
        assert.equal(await menu.getAttribute("id"), "real-owned-menu");
        await page.close();
      } finally {
        await browser.close();
      }
    });

    it("verifies click activation on a real DOM element", async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="btn" aria-controls="real-menu" aria-expanded="false" data-state="closed">Effort</button>
          <div id="real-menu" role="menu" style="display:none; width: 100px; height: 100px;">
            <div data-model-reasoning-effort-slider style="display:none; width: 50px; height: 20px;">
              <span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span>
            </div>
          </div>
          <script>
            const btn = document.getElementById('btn');
            const menu = document.getElementById('real-menu');
            const slider = menu.querySelector('[data-model-reasoning-effort-slider]');
            btn.addEventListener('click', () => {
              btn.setAttribute('aria-expanded', 'true');
              btn.setAttribute('data-state', 'open');
              menu.style.display = 'block';
              slider.style.display = 'block';
            });
          </script>
        `);
        const actClick = await activateChatGptEffortMenu(page, page.locator("#btn"), {
          settleMs: 150,
        });
        assert.equal(actClick.method, "click");
        assert.equal(await actClick.menu.getAttribute("id"), "real-menu");
        await page.close();
      } finally {
        await browser.close();
      }
    });

    it("verifies exit animation guard on real DOM (closed button does not bind closing menu as already-open)", async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="btn" aria-controls="real-menu" aria-expanded="false" data-state="closed">Effort</button>
          <div id="real-menu" role="menu" style="display:block; width: 100px; height: 100px;">
            <div data-model-reasoning-effort-slider style="display:block; width: 50px; height: 20px;">
              <span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span>
            </div>
          </div>
          <script>
            const btn = document.getElementById('btn');
            btn.addEventListener('click', () => {
              btn.setAttribute('aria-expanded', 'true');
              btn.setAttribute('data-state', 'open');
            });
          </script>
        `);
        const actAnim = await activateChatGptEffortMenu(page, page.locator("#btn"), {
          settleMs: 150,
        });
        assert.equal(actAnim.method, "click");
        assert.equal(await page.locator("#btn").getAttribute("aria-expanded"), "true");
        await page.close();
      } finally {
        await browser.close();
      }
    });
  });
});
