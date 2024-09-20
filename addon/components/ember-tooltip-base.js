import Tooltip from 'tooltip.js';
import { getOwner } from '@ember/application';
import { action } from '@ember/object';
import { warn } from '@ember/debug';
import { bind, cancel, run, later, scheduleOnce } from '@ember/runloop';
import { capitalize, w } from '@ember/string';
import Component from '@glimmer/component';
import { isTesting, macroCondition } from '@embroider/macros';
import layout from '../templates/components/ember-tooltip-base';
import { tracked } from '@glimmer/tracking';
import { guidFor } from '@ember/object/internals';
import { inject as service } from '@ember/service';

const ANIMATION_CLASS = 'ember-tooltip-show';
const POPPER_DEFAULT_MODIFIERS = {
  flip: {
    enabled: true,
  },
  preventOverflow: {
    escapeWithReference: true,
  },
};

function getOppositeSide(placement) {
  if (!placement) {
    return null;
  }

  const [side] = placement.split('-');
  let oppositeSide;

  switch (side) {
    case 'top':
      oppositeSide = 'bottom';
      break;
    case 'right':
      oppositeSide = 'left';
      break;
    case 'bottom':
      oppositeSide = 'top';
      break;
    case 'left':
      oppositeSide = 'right';
      break;
  }

  return oppositeSide;
}

function cleanNumber(stringOrNumber) {
  let cleanNumber;

  if (stringOrNumber && typeof stringOrNumber === 'string') {
    cleanNumber = parseInt(stringOrNumber, 10);

    /* Remove invalid parseInt results */

    if (isNaN(cleanNumber) || !isFinite(cleanNumber)) {
      cleanNumber = 0;
    }
  } else {
    cleanNumber = stringOrNumber;
  }

  return cleanNumber;
}

function mergeModifiers(defaults, overrides = {}) {
  const defaultKeys = Object.keys(defaults);
  const overriddenKeys = Object.keys(overrides);
  const keys = [].concat(defaultKeys, overriddenKeys).reduce((acc, key) => {
    if (acc.indexOf(key) === -1) acc.push(key);
    return acc;
  }, []);
  const modifiers = { ...defaults };

  keys.forEach((key) => {
    if (defaultKeys.indexOf(key) !== -1 && overriddenKeys.indexOf(key) !== -1) {
      modifiers[key] = { ...defaults[key], ...overrides[key] };
    } else if (overriddenKeys.indexOf(key) !== -1) {
      modifiers[key] = overrides[key];
    }
  });

  return modifiers;
}

export default class extends Component {
  delay = 0;
  duration = 0;
  // effect= 'slide'; // Options= fade; slide; none // TODO - make slide work
  // event= 'hover'; // Options= hover; click; focus; none
  tooltipClass = 'tooltip';
  arrowClass = 'tooltip-arrow';
  innerClass = 'tooltip-inner';
  isShown = false;
  text = null;
  targetId = null;
  targetElement = null;
  layout = layout;
  updateFor = null;
  popperOptions = null;
  popperContainer = false;
  animationDuration = 200;

  /* Actions */

  onDestroy = null;
  onHide = null;
  onRender = null;
  onShow = null;

  @service fastboot;

  @tracked currentElement = null;
  @tracked _isShown = false;

  get eventOrDefault() {
    return this.args.event || 'hover';
  }

  get sideOrDefault() {
    return this.args.side || 'top';
  }

  get effectOrDefault() {
    return this.args.effect || 'slide';
  }

  get spacingOrDefault() {
    return this.args.spacing || 10;
  }

  get tooltipClassOrDefault() {
    return this.args.tooltipClass || 'tooltip';
  }

  get arrowClassOrDefault() {
    return this.args.arrowClass || 'tooltip-arrow';
  }

  get innerClassOrDefault() {
    return this.args.innerClass || 'tooltip-inner';
  }

  get isShown() {
    return this.args.isShown ?? this._isShown;
  }

  set isShown(value) {
    this.args?.onShow?.(value);
    this._isShown = value;
  }

  get currentElementId() {
    return guidFor(this);
  }

  get currentElement() {
    return document.getElementById(this.currentElementId);
  }

  _hideOn = null;
  get hideOn() {
    if (this._hideOn || this.args.hideOn) {
      return this.args.hideOn || this._hideOn;
    }

    const event = this.eventOrDefault;

    let hideOn;

    switch (event) {
      case 'hover':
        hideOn = 'mouseleave';
        break;
      case 'focus':
        hideOn = 'blur';
        break;
      case 'ready':
        hideOn = null;
        break;
      default:
        hideOn = event;
        break;
    }

    return hideOn;
  }

  set hideOn(value) {
    this._hideOn = value;
  }

  _showOn = null;
  get showOn() {
    if (this.args.showOn || this._showOn) {
      return this.args.showOn || this._showOn;
    }

    const event = this.eventOrDefault;

    let showOn;

    switch (event) {
      case 'hover':
        showOn = 'mouseenter';
        break;
      default:
        showOn = event;
        break;
    }

    return showOn;
  }
  set showOn(value) {
    this._showOn = value;
  }

  get target() {
    const targetId = this.args.targetId;

    let target;

    if (targetId) {
      target = document.getElementById(targetId);

      if (!target) {
        warn('No target found for targetId ', targetId, {
          id: 'ember-tooltips.no-element-with-targetId',
        });
      }
    } else {
      target = this.args.targetElement || this.currentElement?.parentNode;
    }

    return target;
  }

  /* An ID used to identify this tooltip from other tooltips */

  get _renderElementId() {
    const elementId = this.elementId;
    if (elementId) {
      return `${elementId}-et-target`;
    } else {
      return null;
    }
  }

  get _renderElement() {
    const renderElementId = this._renderElementId;
    if (renderElementId) {
      return document.getElementById(renderElementId);
    } else {
      return null;
    }
  }

  get _shouldRenderContent() {
    return this.fastboot.isFastBoot || !this._awaitingTooltipElementRendered;
  }

  @tracked _awaitingTooltipElementRendered = true;
  _tooltipEvents = [];
  _tooltip = null;
  _spacingRequestId = null;

  get _animationDuration() {
    const config = getOwner(this).resolveRegistration('config:environment');
    const inTestingMode = macroCondition(isTesting())
      ? true
      : config.environment === 'test';

    return inTestingMode ? 0 : this.args.animationDuration || 200;
  }

  @action
  handleDidInsert() {
    console.log('handleDidInsert');
    this.createTooltip();
  }

  @action
  handleDidUpdate() {
    if (this.isShown) {
      this.show();

      /* If updateFor exists, update the tooltip incase the changed Attr affected the tooltip content's height or width */

      if (this.args.updateFor !== null && this._tooltip?.popperInstance) {
        this._updatePopper();
      }
    } else {
      this.hide();
    }
  }

  willDestroy() {
    super.willDestroy(...arguments);
    super.willDestroy(...arguments);

    const _tooltipEvents = this._tooltipEvents;

    /* Remove event listeners used to show and hide the tooltip */

    _tooltipEvents.forEach(({ callback, target, eventName } = {}) => {
      target.removeEventListener(eventName, callback);
    });

    this._cleanupTimers();

    this._tooltip?.dispose();

    this._dispatchAction('onDestroy', this);
  }

  addTargetEventListeners() {
    this.addTooltipTargetEventListeners();
  }

  addTooltipBaseEventListeners() {}

  addTooltipTargetEventListeners() {
    /* Setup event handling to hide and show the tooltip */

    const event = this.eventOrDefault;

    /* Setup event handling to hide and show the tooltip */

    if (event === 'none') {
      return;
    }

    const hideOn = this.hideOn;
    const showOn = this.showOn;

    /* If show and hide are the same (e.g. click) toggle
    the visibility */

    if (showOn === hideOn) {
      this._addEventListener(showOn, () => {
        this.toggle();
      });
    } else {
      /* Else, add the show and hide events individually */

      if (showOn !== 'none') {
        this._addEventListener(showOn, () => {
          this.show();
        });
      }

      if (hideOn !== 'none') {
        this._addEventListener(hideOn, () => {
          this.hide();
        });
      }
    }

    /* Hide and show the tooltip on focus and escape
    for accessibility */

    if (event !== 'focus') {
      /* If the event is click, we don't want the
      click to also trigger focusin */

      if (event !== 'click') {
        this._addEventListener('focusin', () => {
          this.show();
        });
      }

      this._addEventListener('focusout', () => {
        this.hide();
      });
    }

    this._addEventListener(
      'keydown',
      (keyEvent) => {
        if (keyEvent.which === 27 && this.isShown) {
          this.hide();
          keyEvent.stopImmediatePropagation(); /* So this callback only fires once per keydown */
          keyEvent.preventDefault();
          return false;
        }
      },
      document,
    );
  }

  createTooltip() {
    const target = this.target;
    const tooltipClass = this.tooltipClassOrDefault;
    const arrowClass = this.arrowClassOrDefault;
    const innerClass = this.innerClassOrDefault;
    const emberTooltipClass = this._tooltipVariantClass;
    const emberTooltipArrowClass = `${w(emberTooltipClass).join(
      '-arrow ',
    )}-arrow`;
    const emberTooltipInnerClass = `${w(emberTooltipClass).join(
      '-inner ',
    )}-inner`;

    const targetTitle = target.title;

    target.removeAttribute('title');

    const tooltip = new Tooltip(target, {
      container: this.args.popperContainer,
      html: true,
      placement: this.sideOrDefault,
      title: '<span></span>',
      trigger: 'manual',
      arrowSelector: `.${w(emberTooltipArrowClass).join('.')}`,
      innerSelector: `.${w(emberTooltipInnerClass).join('.')}`,
      // eslint-disable prettier/prettier
      // prettier-ignore
      template: `<div
                   class="${tooltipClass} ${emberTooltipClass} ember-tooltip-effect-${this.effectOrDefault}"
                   role="tooltip"
                   style="margin:0;margin-${getOppositeSide(this.sideOrDefault)}:${this.spacing}px;">
                   <div class="${arrowClass} ${emberTooltipArrowClass}"></div>
                   <div class="${innerClass} ${emberTooltipInnerClass}" id="${this.get('_renderElementId')}"></div>
                 </div>`,
      // eslint-enable prettier/prettier

      popperOptions: {
        modifiers: mergeModifiers(
          POPPER_DEFAULT_MODIFIERS,
          this.popperOptions?.modifiers,
        ),

        onCreate: () => {
          run(() => {
            this._dispatchAction('onRender', this);

            this._awaitingTooltipElementRendered = false;

            /* The tooltip element must exist in order to add event listeners to it */

            this.addTooltipBaseEventListeners();

            /* Once the wormhole has done it's work, we need the tooltip to be positioned again */
            scheduleOnce('afterRender', this, this._updatePopper);

            target.setAttribute('title', targetTitle);
          });
        },

        onUpdate: () => {
          this.setSpacing();
        },
      },
    });

    /* Add a class to the tooltip target */

    target.classList.add('ember-tooltip-target');

    this.addTargetEventListeners();
    this._tooltip = tooltip;

    /* If user passes isShown=true, show the tooltip as soon as it's created */

    if (this.isShown) {
      this.show();
    }
  }

  _updatePopper() {
    const { popperInstance } = this._tooltip;
    popperInstance.update();
  }

  setSpacing() {
    if (!this.isShown || this.isDestroying) {
      return;
    }

    this._spacingRequestId = requestAnimationFrame(() => {
      this._spacingRequestId = null;

      if (!this.isShown || this.isDestroying) {
        return;
      }

      const { popperInstance } = this._tooltip;
      const { popper } = popperInstance;
      const side = popper.getAttribute('x-placement');
      const marginSide = getOppositeSide(side);
      const { style } = popper;

      style.marginTop = 0;
      style.marginRight = 0;
      style.marginBottom = 0;
      style.marginLeft = 0;

      popper.style[`margin${capitalize(marginSide)}`] =
        `${this.spacingOrDefault}px`;
    });
  }

  hide() {
    if (this.isDestroying) {
      return;
    }

    /* If the tooltip is about to be showed by
    a delay, stop is being shown. */

    cancel(this._showTimer);

    this._hideTooltip();
  }

  show() {
    if (this.isDestroying) {
      return;
    }

    const delay = this.args.delay || 0;
    const duration = this.args.duration || 0;

    cancel(this._showTimer);
    cancel(this._completeHideTimer);

    if (duration) {
      this.setHideTimer(duration);
    }

    if (delay) {
      this.setShowTimer(delay);
    } else {
      this._showTooltip();
    }
  }

  setHideTimer(duration) {
    duration = cleanNumber(duration);

    cancel(this._hideTimer);

    if (duration) {
      /* Hide tooltip after specified duration */

      const hideTimer = later(this, this.hide, duration);

      /* Save timer ID for canceling should an event
      hide the tooltip before the duration */

      this._hideTimer = hideTimer;
    }
  }

  setShowTimer(delay) {
    delay = cleanNumber(delay);

    if (!this.args.delayOnChange === undefined) {
      /* If the `delayOnChange` property is set to false, we
      don't want to delay opening this tooltip/popover if there is
      already a tooltip/popover shown in the DOM. Check that here
      and adjust the delay as needed. */

      let shownTooltipsOrPopovers = document.querySelectorAll(
        `.${ANIMATION_CLASS}`,
      );

      if (shownTooltipsOrPopovers.length) {
        delay = 0;
      }
    }

    const _showTimer = later(
      this,
      () => {
        this._showTooltip();
      },
      delay,
    );

    this._showTimer = _showTimer;
  }

  _hideTooltip() {
    const _tooltip = this._tooltip;

    if (!_tooltip || this.isDestroying) {
      return;
    }

    if (_tooltip.popperInstance) {
      _tooltip.popperInstance.popper.classList.remove(ANIMATION_CLASS);
    }

    const _completeHideTimer = later(() => {
      if (this.isDestroying) {
        return;
      }

      cancelAnimationFrame(this._spacingRequestId);
      _tooltip.hide();

      this._isHiding = false;
      this.isShown = false;
      this._dispatchAction('onHide', this);
    }, this._animationDuration);

    this._completeHideTimer = _completeHideTimer;
  }

  _showTooltip() {
    if (this.isDestroying) {
      return;
    }

    const _tooltip = this._tooltip;

    _tooltip.show();

    this.isShown = true;

    run(() => {
      if (this.isDestroying) {
        return;
      }

      _tooltip.popperInstance.popper.classList.add(ANIMATION_CLASS);

      this._dispatchAction('onShow', this);
    });
  }

  toggle() {
    /* We don't use toggleProperty because we centralize
    logic for showing and hiding in the show() and hide()
    methods. */

    if (this.isShown) {
      this.hide();
    } else {
      this.show();
    }
  }

  _addEventListener(eventName, callback, element) {
    const target = element || this.target;

    /* Remember event listeners so they can removed on teardown */

    const boundCallback = bind(this, callback);

    this._tooltipEvents.push({
      callback: boundCallback,
      target,
      eventName,
    });

    /* Add the event listeners */

    target.addEventListener(eventName, boundCallback);
  }

  _dispatchAction(actionName, ...args) {
    const action = this[actionName];

    if (!this.isDestroying && !this.isDestroyed && action) {
      action(...args);
    }
  }

  _cleanupTimers() {
    cancel(this._showTimer);
    cancelAnimationFrame(this._spacingRequestId);
  }
}
