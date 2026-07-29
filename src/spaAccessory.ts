// TODO: auto (cooling threshold temperature + heating threshold temperature)
// TODO: setting for minimum+maximum temperature override? so we can for example have 20-40 selection instead of 10-40?
// TODO: thermostat vs heatercooler ???
// TODO: "fakegato"?
// TODO: changing celcius to fahrenheit

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IntexPlusPlatform } from './platform.js';
import * as net from 'net';

const SPA_PORT = 8990;
/** How often we ask the controller for a fresh device state. */
const REFRESH_INTERVAL_MS = 5000;
/** How long a single request may stay unanswered before it is failed. */
const RESPONSE_TIMEOUT_MS = 10000;
/** How long a connect attempt may hang before we give up and start over. */
const CONNECT_TIMEOUT_MS = 15000;
/**
 * How long the connection may stay silent before we tear it down and reconnect.
 * The controller happily keeps a TCP connection open — and keeps ACKing our
 * writes — while its application side is wedged, and a controller that drops off
 * Wi-Fi never sends a FIN or RST, so a socket error is not something we can wait
 * for. Without this the plugin sits on a dead-but-established socket forever.
 */
const SILENCE_TIMEOUT_MS = 45000;
const WATCHDOG_INTERVAL_MS = 5000;
const RECONNECT_MIN_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 60000;
/** Bounds the receive buffer in case the controller sends something we never parse. */
const MAX_RX_BUFFER_LENGTH = 64 * 1024;

/**
 * The controller only re-samples the water temperature when its state changes; polling
 * alone leaves the reported value stale for hours. Briefly toggling whatever is already
 * running nudges it into publishing a fresh reading.
 */
const DEFAULT_TEMPERATURE_REFRESH_INTERVAL_MINUTES = 15;
/** How long the toggled-off state is held before it is toggled back on. */
const TEMPERATURE_REFRESH_PAUSE_MS = 5000;
/** A user command this recent means we skip the nudge rather than fight the user. */
const TEMPERATURE_REFRESH_USER_COMMAND_GRACE_MS = 15000;
/** Leaving the heater or the filter off is worse than a few extra retries. */
const TEMPERATURE_REFRESH_RESTORE_ATTEMPTS = 5;
const TEMPERATURE_REFRESH_RESTORE_RETRY_MS = 5000;

/** Toggle commands. Each one flips the corresponding function on the controller. */
const COMMAND_HEAT_ON_OFF = '8888060F010010C8';
const COMMAND_FILTER_ON_OFF = '8888060F010004D4';
const COMMAND_BUBBLES_ON_OFF = '8888060F010400D4';
const COMMAND_JET_ON_OFF = '8888060F011000C8';
const COMMAND_SANITIZER_ON_OFF = '8888060F010001D7';
const COMMAND_POWER_ON_OFF = '8888060F01400098';
const COMMAND_REFRESH = '8888060FEE0F01DA';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Message {
  sid: string;
  type: number;
  data: string;
  result?: string;
}

interface DeviceState {
  isBubblesOn: boolean;
  isFilterOn: boolean;
  isHeaterOn: boolean;
  isWaterJetOn: boolean;
  isSanitizerOn: boolean;
  isControllerOn: boolean;
  // Undefined when the spa unit is powered off but the controller is still reachable.
  currentTemperature?: number;
  targetTemperature: number;
  temperatureUnit: 'Celsius' | 'Fahrenheit';
}

export class SpaAccessory {
  private client?: net.Socket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private messageQueue: Map<string, { resolve: (value: Message) => void; reject: (reason?: Error) => void; timeout: NodeJS.Timeout }>;
  // The controller echoes the sid back untouched, so it only has to be unique per
  // connection. A bare `Date.now()` collides whenever two messages go out within the
  // same millisecond, which overwrites the first queue entry and strands its promise.
  private nextSid = Date.now();
  // TCP is a stream: a response can arrive split across chunks, and two responses can
  // arrive in one chunk. Bytes that do not yet form a complete JSON object wait here.
  private rxBuffer = '';
  // When we last heard anything well-formed from the controller. This, rather than the
  // socket's state, is what tells us the connection is actually alive.
  private lastResponseAt = 0;
  private isRefreshInFlight = false;
  // Serializes every state-changing command so a temperature-refresh nudge and a
  // HomeKit request can never interleave and toggle each other's changes back.
  private commandLock: Promise<unknown> = Promise.resolve();
  private lastUserCommandAt = 0;
  // While a nudge is running we keep reporting the pre-nudge values to HomeKit, so the
  // brief toggle does not show up in the Home app or trigger the user's automations.
  private nudgedState?: Partial<Pick<DeviceState, 'isHeaterOn' | 'isFilterOn'>>;
  private isOnline = false;
  private deviceState?: DeviceState;
  // Last temperature reading we consider usable. Cached across reconnects and, via
  // accessory.context, across Homebridge restarts, so we can keep reporting a
  // plausible CurrentTemperature while the spa unit is powered off.
  private lastKnownCurrentTemperature?: number;

  private thermostatService: Service;
  private filterService: Service;
  private bubblesService: Service;
  private batteryService: Service;
  private controllerService?: Service;
  private waterJetService?: Service;
  private sanitizerService?: Service;

  constructor(
    private readonly platform: IntexPlusPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly host: string,
  ) {
    this.messageQueue = new Map();

    // Restore the last usable temperature persisted from a previous run, if any.
    this.lastKnownCurrentTemperature = this.accessory.context.lastKnownCurrentTemperature;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Intex')
      .setCharacteristic(this.platform.Characteristic.Model, 'PureSpa')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, host);

    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);
    this.thermostatService.setCharacteristic(this.platform.Characteristic.Name, 'Intex PureSpa');
    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));
    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      });
    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));
    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));
    this.thermostatService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // TODO:?
    // this.thermostatServiceIInne.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Filter');

    this.filterService = this.accessory.getServiceById(this.platform.Service.Switch, 'Filter') ||
      this.accessory.addService(new this.platform.Service.Switch('Filter', 'Filter'));
    this.filterService.setCharacteristic(this.platform.Characteristic.Name, 'Filter');
    // TODO:?
    this.filterService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Filter');
    this.filterService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getFilterOn.bind(this))
      .onSet(this.setFilterOn.bind(this));

    this.bubblesService = this.accessory.getServiceById(this.platform.Service.Switch, 'Bubbles') ||
      this.accessory.addService(new this.platform.Service.Switch('Bubbles', 'Bubbles'));
    this.bubblesService.setCharacteristic(this.platform.Characteristic.Name, 'Bubbles');
      // TODO:?
    this.bubblesService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Bubbles');
    this.bubblesService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getBubblesOn.bind(this))
      .onSet(this.setBubblesOn.bind(this));

    // A Battery service is the canonical, warning-free way to raise a generic alert
    // on the accessory tile in the Home app. We repurpose its low-battery indicator
    // to flag that the spa unit is powered off (no live temperature) while the
    // controller itself is still reachable.
    this.batteryService = this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery);
    this.batteryService.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));

    if (this.platform.config.showUnusedSwitches) {
      this.controllerService = this.accessory.getServiceById(this.platform.Service.Switch, 'Controller') ||
        this.accessory.addService(new this.platform.Service.Switch('Controller', 'Controller'));
      this.controllerService.setCharacteristic(this.platform.Characteristic.Name, 'Controller');
      this.controllerService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getControllerOn.bind(this))
        .onSet(this.setControllerOn.bind(this));

      this.waterJetService = this.accessory.getServiceById(this.platform.Service.Switch, 'Water Jet') ||
        this.accessory.addService(new this.platform.Service.Switch('Water Jet', 'Water Jet'));
      this.waterJetService.setCharacteristic(this.platform.Characteristic.Name, 'Water Jet');
      this.waterJetService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getWaterJetOn.bind(this))
        .onSet(this.setWaterJetOn.bind(this));

      this.sanitizerService = this.accessory.getServiceById(this.platform.Service.Switch, 'Sanitizer') ||
        this.accessory.addService(new this.platform.Service.Switch('Sanitizer', 'Sanitizer'));
      this.sanitizerService.setCharacteristic(this.platform.Characteristic.Name, 'Sanitizer');
      this.sanitizerService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getSanitizerOn.bind(this))
        .onSet(this.setSanitizerOn.bind(this));
    }

    this.connect();
    this.startSendingRefreshCommand();
    this.startConnectionWatchdog();
    this.startTemperatureRefresh();
  }

  private connect() {
    this.teardownSocket();

    const client = new net.Socket();
    this.client = client;

    client.on('data', this.onData.bind(this));
    client.on('error', this.onError.bind(this));
    client.on('close', this.onClose.bind(this));
    client.on('timeout', this.onTimeout.bind(this));

    // Ask the OS to notice a peer that vanished without saying goodbye. This is only a
    // backstop — it takes minutes to fire, and it cannot see a controller that is still
    // answering at the TCP level while its application side has stopped responding.
    client.setKeepAlive(true, 10000);
    // A black-holed SYN otherwise hangs for the OS default (over two minutes).
    client.setTimeout(CONNECT_TIMEOUT_MS);

    client.connect(SPA_PORT, this.host, () => {
      this.platform.log.debug('Connected to the spa');
      // Not proof the controller will answer us, only that the socket is up. The
      // watchdog below decides whether the connection is actually usable.
      this.lastResponseAt = Date.now();
      this.isOnline = true;
      // Only a backstop once we are connected: Node resets this timer on writes as well
      // as reads, and we write a refresh every few seconds. startConnectionWatchdog() is
      // what actually notices a controller that has stopped answering.
      client.setTimeout(SILENCE_TIMEOUT_MS);
    });
  }

  private teardownSocket() {
    const client = this.client;
    if (!client) {
      return;
    }
    this.client = undefined;
    this.rxBuffer = '';
    client.removeAllListeners();
    // A socket that errors with no 'error' listener attached throws an uncaught
    // exception and takes the whole bridge down with it.
    client.on('error', () => { /* the socket is on its way out */ });
    // Closing the socket also releases the controller's client slot, which it does not
    // reclaim on its own — that is why restarting the plugin fixes a wedged connection.
    client.destroy();
  }

  private scheduleReconnect(reason: string) {
    const wasOnline = this.isOnline;
    this.isOnline = false;
    this.teardownSocket();
    // Nothing is going to answer these now; failing them immediately beats making
    // HomeKit wait out every pending request's timeout.
    this.failPendingMessages();

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_MIN_DELAY_MS * 2 ** this.reconnectAttempts);
    // Log the first failure of a streak loudly and the rest quietly, so a spa that is
    // switched off for the season does not flood the log.
    const message = `Lost connection to the spa (${reason}), reconnecting in ${Math.round(delay / 1000)}s`;
    if (wasOnline || this.reconnectAttempts === 0) {
      this.platform.log.warn(message);
    } else {
      this.platform.log.debug(message);
    }
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /**
   * Watches for a connection that is up but not talking. This is the failure the socket
   * layer cannot see: the spa drops off Wi-Fi, or its controller wedges, and the plugin
   * would otherwise keep writing into an established socket forever.
   */
  private startConnectionWatchdog() {
    setInterval(() => {
      if (!this.isOnline || this.reconnectTimer) {
        return;
      }
      const silentFor = Date.now() - this.lastResponseAt;
      if (silentFor >= SILENCE_TIMEOUT_MS) {
        this.scheduleReconnect(`no response for ${Math.round(silentFor / 1000)}s`);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private startSendingRefreshCommand() {
    setInterval(() => {
      this.sendRefreshCommand();
    }, REFRESH_INTERVAL_MS);
  }

  private async sendRefreshCommand() {
    if (!this.isOnline || this.isRefreshInFlight) {
      return;
    }
    this.isRefreshInFlight = true;
    try {
      // The official app sends a { sid: ..., type: 0, data: "" } heartbeat message every 50 seconds
      // but the response to the heartbeat does not return a device state.
      await this.postMessage({
        type: 1,
        data: COMMAND_REFRESH,
      });
    } catch (error) {
      // Expected while the connection is down; the watchdog decides when to reconnect.
      this.platform.log.debug('Refresh failed:', error instanceof Error ? error.message : error);
    } finally {
      this.isRefreshInFlight = false;
    }
  }

  private onData(data: Buffer) {
    // The payload is ASCII (JSON with hex-encoded data), so decoding per chunk is safe.
    this.rxBuffer += data.toString();

    if (this.rxBuffer.length > MAX_RX_BUFFER_LENGTH) {
      this.platform.log.warn('Discarding unparseable data from the spa');
      this.rxBuffer = '';
      return;
    }

    for (const rawMessage of this.takeCompleteMessages()) {
      try {
        this.handleMessage(rawMessage);
      } catch (error) {
        // Last resort. Anything thrown from a socket handler is an uncaught exception,
        // and Homebridge stops restarting a child bridge that crashes five times: the
        // plugin then stays down until someone restarts it by hand. Whatever the bug is,
        // logging it beats taking the bridge down over one bad message.
        this.platform.log.error('Failed to handle a message from the spa:', rawMessage, error);
      }
    }
  }

  /**
   * Splits the receive buffer into complete top-level JSON objects, leaving any trailing
   * partial object behind for the next chunk. The controller frames nothing, so back-to-back
   * responses can share a chunk and a single response can be split across two.
   */
  private takeCompleteMessages(): string[] {
    const messages: string[] = [];
    let depth = 0;
    let inString = false;
    let isEscaped = false;
    let start = -1;
    let consumedUpTo = 0;

    for (let i = 0; i < this.rxBuffer.length; i++) {
      const character = this.rxBuffer[i];

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (character === '\\') {
          isEscaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        if (depth === 0) {
          start = i;
        }
        depth++;
      } else if (character === '}' && depth > 0) {
        depth--;
        if (depth === 0) {
          messages.push(this.rxBuffer.slice(start, i + 1));
          consumedUpTo = i + 1;
        }
      }
    }

    this.rxBuffer = this.rxBuffer.slice(consumedUpTo);

    return messages;
  }

  private handleMessage(rawMessage: string) {
    this.platform.log.debug('Received message:', rawMessage);

    let message: Message;
    try {
      message = JSON.parse(rawMessage) as Message;
    } catch (error) {
      // Never throw out of a socket handler: that is an uncaught exception, not a
      // logged warning.
      this.platform.log.warn('Ignoring malformed message from the spa:', rawMessage, error instanceof Error ? error.message : error);
      return;
    }

    // Any well-formed message proves the controller is still talking to us.
    this.lastResponseAt = Date.now();
    if (this.reconnectAttempts > 0) {
      this.platform.log.info('Reconnected to the spa');
      this.reconnectAttempts = 0;
    }

    const pending = this.messageQueue.get(message.sid);
    if (!pending) {
      return;
    }
    this.messageQueue.delete(message.sid);
    clearTimeout(pending.timeout);

    if (message.result !== 'ok') {
      this.platform.log.error(`Response result not ok: ${rawMessage}`);
      pending.reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      return;
    }

    pending.resolve(message);

    try {
      this.parseDeviceState(message.data);
    } catch (error) {
      this.platform.log.warn('Failed to parse device state:', error instanceof Error ? error.message : error);
    }
  }

  private onError(err: Error) {
    this.scheduleReconnect(err.message);
  }

  private onClose() {
    this.scheduleReconnect('connection closed');
  }

  private onTimeout() {
    // 'timeout' does not close the socket by itself; scheduleReconnect() does.
    this.scheduleReconnect(this.isOnline ? 'socket idle' : 'connect timed out');
  }

  private failPendingMessages() {
    for (const pending of this.messageQueue.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
    this.messageQueue.clear();
  }

  private get temperatureRefreshIntervalMinutes(): number {
    const configured = this.platform.config.temperatureRefreshInterval;
    if (configured === undefined || configured === null || configured === '') {
      return DEFAULT_TEMPERATURE_REFRESH_INTERVAL_MINUTES;
    }

    const minutes = Number(configured);
    if (!Number.isFinite(minutes) || minutes < 0) {
      this.platform.log.warn('Ignoring invalid temperatureRefreshInterval:', configured);
      return DEFAULT_TEMPERATURE_REFRESH_INTERVAL_MINUTES;
    }

    return minutes;
  }

  /**
   * The controller only re-samples the water temperature when its state changes, so
   * polling on its own can return the same reading for hours. Briefly cycling whatever is
   * already running makes it publish a fresh one.
   */
  private startTemperatureRefresh() {
    const minutes = this.temperatureRefreshIntervalMinutes;
    if (minutes === 0) {
      this.platform.log.debug('Periodic temperature refresh is disabled');
      return;
    }

    setInterval(() => {
      this.refreshTemperatureReading();
    }, minutes * 60 * 1000);
  }

  private async refreshTemperatureReading() {
    if (!this.isOnline || this.nudgedState) {
      return;
    }

    try {
      await this.runCommand(() => this.nudgeTemperatureReading(), false);
    } catch (error) {
      this.platform.log.debug('Temperature refresh failed:', error instanceof Error ? error.message : error);
    }
  }

  private async nudgeTemperatureReading() {
    const state = this.deviceState;
    if (!this.isOnline || !state || !state.isControllerOn) {
      return;
    }

    if (Date.now() - this.lastUserCommandAt < TEMPERATURE_REFRESH_USER_COMMAND_GRACE_MS) {
      this.platform.log.debug('Skipping temperature refresh, the spa was just used');
      return;
    }

    // Cycle something that is already running so the spa carries on doing what it was
    // doing: the heater if it is on (which leaves the pump circulating), otherwise the
    // filter. With neither running there is nothing to cycle without changing what the
    // spa is actually doing, and the water is not circulating anyway.
    const target = state.isHeaterOn ? 'heater' : (state.isFilterOn ? 'filter' : undefined);
    if (!target) {
      this.platform.log.debug('Skipping temperature refresh, neither the heater nor the filter is running');
      return;
    }

    const command = target === 'heater' ? COMMAND_HEAT_ON_OFF : COMMAND_FILTER_ON_OFF;
    this.platform.log.debug(`Refreshing the temperature reading by cycling the ${target}`);

    this.nudgedState = target === 'heater' ? { isHeaterOn: true } : { isFilterOn: true };
    try {
      await this.postMessage({ type: 1, data: command });
      await delay(TEMPERATURE_REFRESH_PAUSE_MS);
    } finally {
      await this.restoreAfterNudge(target, command);
      this.nudgedState = undefined;
    }
  }

  /**
   * Turns the cycled function back on, verifying against the controller rather than
   * assuming: a single lost command would otherwise leave the spa silently not heating.
   */
  private async restoreAfterNudge(target: 'heater' | 'filter', command: string) {
    for (let attempt = 1; attempt <= TEMPERATURE_REFRESH_RESTORE_ATTEMPTS; attempt++) {
      try {
        // The response to a toggle does not necessarily carry a device state, so ask.
        await this.postMessage({ type: 1, data: COMMAND_REFRESH });
        const isOn = target === 'heater' ? this.deviceState?.isHeaterOn : this.deviceState?.isFilterOn;
        if (isOn) {
          return;
        }
        await this.postMessage({ type: 1, data: command });
      } catch (error) {
        this.platform.log.debug(
          `Restoring the ${target} after a temperature refresh failed (attempt ${attempt}):`,
          error instanceof Error ? error.message : error,
        );
        if (attempt < TEMPERATURE_REFRESH_RESTORE_ATTEMPTS) {
          await delay(TEMPERATURE_REFRESH_RESTORE_RETRY_MS);
        }
      }
    }

    this.platform.log.warn(`Could not turn the ${target} back on after refreshing the temperature reading`);
  }

  /**
   * Serializes state-changing commands. The controller only understands toggles, so a
   * temperature-refresh nudge and a HomeKit request that overlap would each undo the
   * other's change.
   */
  private runCommand<T>(command: () => Promise<T>, isUserCommand = true): Promise<T> {
    const result = this.commandLock.then(() => {
      if (isUserCommand) {
        this.lastUserCommandAt = Date.now();
      }
      return command();
    });

    // Keep the chain going after a failure, and never leave the lock's own copy of the
    // promise unhandled.
    this.commandLock = result.catch(() => undefined);

    return result;
  }

  private async postMessage(message: { type: number; data: string }): Promise<Message> {
    return new Promise((resolve, reject) => {
      const client = this.client;
      if (!client || client.destroyed) {
        reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        return;
      }

      const sid = `${this.nextSid++}`;
      const timeout = setTimeout(() => {
        if (this.messageQueue.has(sid)) {
          this.messageQueue.delete(sid);
          this.platform.log.debug('Response timeout');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.OPERATION_TIMED_OUT));
        }
      }, RESPONSE_TIMEOUT_MS);

      this.messageQueue.set(sid, { resolve, reject, timeout });

      const stringMessage = JSON.stringify({
        sid: sid,
        type: message.type,
        data: message.data,
      });

      // Extra space added on purpose to line up sent and received messages in logs
      this.platform.log.debug('Sending message: ', stringMessage);

      client.write(stringMessage);
    });
  }

  private parseDeviceState(data: string) {
    if (!data.startsWith('FFFF')) {
      return;
    }

    const buffer = Buffer.from(data, 'hex');
    // A truncated payload would make the reads below throw a RangeError.
    if (buffer.length <= 0x0f) {
      this.platform.log.warn('Ignoring truncated device state:', data);
      return;
    }

    const isBubblesOn = (buffer.readUInt8(0x05) & 0x10) === 0x10;
    const isFilterOn = (buffer.readUInt8(0x05) & 0x02) === 0x02;
    const isHeaterOn = (buffer.readUInt8(0x05) & 0x04) === 0x04;
    const isWaterJetOn = (buffer.readUInt8(0x05) & 0x08) === 0x08;
    const isSanitizerOn = (buffer.readUInt8(0x05) & 0x20) === 0x20;
    const isControllerOn = (buffer.readUInt8(0x05) & 0x01) === 0x01;
    const rawCurrentTemperature = buffer.readUInt8(0x07);
    // When the spa unit is powered off but the controller is still reachable,
    // the current temperature byte reads as a sentinel (e.g. 190) that is well
    // above any plausible water temperature in either Celsius or Fahrenheit.
    const currentTemperature = rawCurrentTemperature >= 110 ? undefined : rawCurrentTemperature;
    let targetTemperature = buffer.readUInt8(0x0f);

    let temperatureUnit: 'Celsius' | 'Fahrenheit';
    if (targetTemperature <= 9) {
      targetTemperature = 10;
      temperatureUnit = 'Celsius';
    } else if (targetTemperature >= 10 && targetTemperature < 50) {
      temperatureUnit = 'Celsius';
    } else if (targetTemperature >= 50 && targetTemperature <= 104) {
      temperatureUnit = 'Fahrenheit';
    } else {
      targetTemperature = 104;
      temperatureUnit = 'Fahrenheit';
    }

    // const previousIsOnline = this.isOnline;
    this.isOnline = true;

    this.deviceState = {
      isBubblesOn,
      isFilterOn,
      isHeaterOn,
      isWaterJetOn,
      isSanitizerOn,
      isControllerOn,
      currentTemperature,
      targetTemperature,
      temperatureUnit,
    };

    // Cache the latest usable reading (and persist it across restarts) so we can keep
    // reporting it once the spa unit powers off and stops sending a real value.
    if (currentTemperature !== undefined && currentTemperature !== this.lastKnownCurrentTemperature) {
      this.lastKnownCurrentTemperature = currentTemperature;
      this.accessory.context.lastKnownCurrentTemperature = currentTemperature;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }

    // TODO
    // if (!previousIsOnline) {
    this.platform.log.debug('Initial spa state:', this.deviceState);
    // }

    // A temperature-refresh nudge briefly toggles the heater or the filter off. HomeKit
    // keeps seeing the pre-nudge value for that window, so the Home app does not flicker
    // and automations do not see the spa turn itself off and straight back on.
    const reported = { ...this.deviceState, ...this.nudgedState };

    this.filterService.updateCharacteristic(this.platform.Characteristic.On, reported.isFilterOn);
    this.bubblesService.updateCharacteristic(this.platform.Characteristic.On, reported.isBubblesOn);
    this.controllerService?.updateCharacteristic(this.platform.Characteristic.On, reported.isControllerOn);
    this.waterJetService?.updateCharacteristic(this.platform.Characteristic.On, reported.isWaterJetOn);
    this.sanitizerService?.updateCharacteristic(this.platform.Characteristic.On, reported.isSanitizerOn);
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      reported.isHeaterOn ?
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT :
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      reported.isHeaterOn ?
        this.platform.Characteristic.TargetHeatingCoolingState.HEAT :
        this.platform.Characteristic.TargetHeatingCoolingState.OFF,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.deviceState.temperatureUnit === 'Celsius' ?
        this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS :
        this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
    );
    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: this.deviceState.temperatureUnit === 'Celsius' ? 10 : 50,
        maxValue: this.deviceState.temperatureUnit === 'Celsius' ? 40 : 104,
        minStep: 1,
      });
    // Report the live reading when present, otherwise hold the last usable value so
    // HomeKit never sees a missing required characteristic (which shows "No Response").
    if (this.lastKnownCurrentTemperature !== undefined) {
      this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.lastKnownCurrentTemperature);
    }
    // Flag a powered-off spa unit (no live temperature) as a low-battery alert.
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      this.deviceState.currentTemperature === undefined ?
        this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
        this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.deviceState.targetTemperature);
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.nudgedState?.isHeaterOn ?? this.deviceState.isHeaterOn;

    this.platform.log.debug('Thermostat Get Characteristic CurrentHeatingCoolingState ->', value);

    return value ?
      this.platform.Characteristic.CurrentHeatingCoolingState.HEAT :
      this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    return this.runCommand(() => this.applyTargetHeatingCoolingState(value));
  }

  private async applyTargetHeatingCoolingState(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const effectiveValue = value === this.platform.Characteristic.TargetHeatingCoolingState.HEAT;

    if (effectiveValue as boolean !== this.deviceState.isHeaterOn) {
      // Ensure filter is enabled before enabling the heater
      if (effectiveValue && !this.deviceState.isFilterOn) {
        await this.applyFilterOn(true);
      }

      await this.postMessage({
        type: 1,
        data: COMMAND_HEAT_ON_OFF,
      });
    }

    this.platform.log.debug('Thermostat Set Characteristic TargetHeatingCoolingState ->', value);
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.nudgedState?.isHeaterOn ?? this.deviceState.isHeaterOn;

    this.platform.log.debug('Thermostat Get Characteristic TargetHeatingCoolingState ->', value);

    return value ?
      this.platform.Characteristic.TargetHeatingCoolingState.HEAT :
      this.platform.Characteristic.TargetHeatingCoolingState.OFF;
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    // Prefer the live reading; fall back to the last usable value (cached across
    // restarts). Only when we have never seen a usable reading do we report the
    // value as unavailable, preserving the previous behavior.
    const value = this.deviceState?.currentTemperature ?? this.lastKnownCurrentTemperature;
    if (value === undefined) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    this.platform.log.debug('Thermostat Get Characteristic CurrentTemperature ->', value);

    return value;
  }

  async getStatusLowBattery(): Promise<CharacteristicValue> {
    // Never throw here: an error thrown from a characteristic getter is exactly what
    // makes an accessory show as "No Response". Default to "normal" until a device
    // state tells us the live temperature is unavailable (spa unit powered off).
    const isFault = this.deviceState !== undefined && this.deviceState.currentTemperature === undefined;

    return isFault ?
      this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
      this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    return this.runCommand(() => this.applyTargetTemperature(value));
  }

  private async applyTargetTemperature(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }


    if (value as number !== this.deviceState.targetTemperature) {
      const command: string = {
        10: '8888050F0C0AC4',
        11: '8888050F0C0BC3',
        12: '8888050F0C0CC2',
        13: '8888050F0C0DC1',
        14: '8888050F0C0EC0',
        15: '8888050F0C0FBF',
        16: '8888050F0C10BE',
        17: '8888050F0C11BD',
        18: '8888050F0C12BC',
        19: '8888050F0C13BB',
        20: '8888050F0C14BA',
        21: '8888050F0C15B9',
        22: '8888050F0C16B8',
        23: '8888050F0C17B7',
        24: '8888050F0C18B6',
        25: '8888050F0C19B5',
        26: '8888050F0C1AB4',
        27: '8888050F0C1BB3',
        28: '8888050F0C1CB2',
        29: '8888050F0C1DB1',
        30: '8888050F0C1EB0',
        31: '8888050F0C1FAF',
        32: '8888050F0C20AE',
        33: '8888050F0C21AD',
        34: '8888050F0C22AC',
        35: '8888050F0C23AB',
        36: '8888050F0C24AA',
        37: '8888050F0C25A9',
        38: '8888050F0C26A8',
        39: '8888050F0C27A7',
        40: '8888050F0C28A6',
      }[value as number] ?? (() => {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      })();

      await this.postMessage({
        type: 1,
        data: command, // TempSet command
      });
    }

    this.platform.log.debug('Thermostat Set Characteristic TargetTemperature ->', value);
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.deviceState.targetTemperature;

    this.platform.log.debug('Thermostat Get Characteristic TargetTemperature ->', value);

    return value;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    // if (!this.isOnline) {
    //   throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    // }
    // if (!this.deviceState) {
    //   throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    // }

    // const effectiveValue = value === this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS ? 'Celsius' : 'Fahrenheit';

    // if (effectiveValue !== this.deviceState.temperatureUnit) {
    //   await this.postMessage({
    //     type: 1,
    //     data: 'TODO', // TempSwitch command
    //   });
    // }

    // this.platform.log.debug('Thermostat Set Characteristic TemperatureDisplayUnits ->', value);
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.deviceState.temperatureUnit;

    this.platform.log.debug('Thermostat Get Characteristic TemperatureDisplayUnits ->', value);

    return value === 'Celsius' ?
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS :
      this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }

  async setFilterOn(value: CharacteristicValue) {
    return this.runCommand(() => this.applyFilterOn(value));
  }

  private async applyFilterOn(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isFilterOn) {
      // Ensure heater is disabled before disabling the heater
      if (!value && this.deviceState.isHeaterOn) {
        await this.applyTargetHeatingCoolingState(this.platform.Characteristic.TargetHeatingCoolingState.OFF);
      }

      await this.postMessage({
        type: 1,
        data: COMMAND_FILTER_ON_OFF,
      });
    }

    this.platform.log.debug('Filter Set Characteristic On ->', value);
  }

  async getFilterOn(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.nudgedState?.isFilterOn ?? this.deviceState.isFilterOn;

    this.platform.log.debug('Filter Get Characteristic On ->', value);

    return value;
  }

  async setBubblesOn(value: CharacteristicValue) {
    return this.runCommand(() => this.applyBubblesOn(value));
  }

  private async applyBubblesOn(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isBubblesOn) {
      await this.postMessage({
        type: 1,
        data: COMMAND_BUBBLES_ON_OFF,
      });
    }

    this.platform.log.debug('Bubbles Set Characteristic On ->', value);
  }

  async getBubblesOn(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.deviceState.isBubblesOn;

    this.platform.log.debug('Bubbles Get Characteristic On ->', value);

    return value;
  }

  async setControllerOn(value: CharacteristicValue) {
    return this.runCommand(() => this.applyControllerOn(value));
  }

  private async applyControllerOn(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isControllerOn) {
      await this.postMessage({
        type: 1,
        data: COMMAND_POWER_ON_OFF,
      });
    }

    this.platform.log.debug('Controller Set Characteristic On ->', value);
  }

  async getControllerOn(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.deviceState.isControllerOn;

    this.platform.log.debug('Controller Get Characteristic On ->', value);

    return value;
  }

  async setWaterJetOn(value: CharacteristicValue) {
    return this.runCommand(() => this.applyWaterJetOn(value));
  }

  private async applyWaterJetOn(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isWaterJetOn) {
      await this.postMessage({
        type: 1,
        data: COMMAND_JET_ON_OFF,
      });
    }

    this.platform.log.debug('Water Jet Set Characteristic On ->', value);
  }

  async getWaterJetOn(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.deviceState.isWaterJetOn;

    this.platform.log.debug('Water Jet Get Characteristic On ->', value);

    return value;
  }

  async setSanitizerOn(value: CharacteristicValue) {
    return this.runCommand(() => this.applySanitizerOn(value));
  }

  private async applySanitizerOn(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isSanitizerOn) {
      await this.postMessage({
        type: 1,
        data: COMMAND_SANITIZER_ON_OFF,
      });
    }

    this.platform.log.debug('Sanitizer Set Characteristic On ->', value);
  }

  async getSanitizerOn(): Promise<CharacteristicValue> {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    const value = this.deviceState.isSanitizerOn;

    this.platform.log.debug('Sanitizer Get Characteristic On ->', value);

    return value;
  }
}
