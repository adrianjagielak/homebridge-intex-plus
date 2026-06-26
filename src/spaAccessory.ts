// TODO: auto (cooling threshold temperature + heating threshold temperature)
// TODO: setting for minimum+maximum temperature override? so we can for example have 20-40 selection instead of 10-40?
// TODO: thermostat vs heatercooler ???
// TODO: "fakegato"?
// TODO: changing celcius to fahrenheit

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IntexPlusPlatform } from './platform.js';
import * as net from 'net';

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
  private messageQueue: Map<string, { resolve: (value: Message) => void; reject: (reason?: Error) => void; timeout: NodeJS.Timeout }>;
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
  }

  private connect() {
    this.teardownSocket();

    const client = new net.Socket();
    this.client = client;

    client.on('data', this.onData.bind(this));
    client.on('error', this.onError.bind(this));
    client.on('close', this.onClose.bind(this));

    client.connect(8990, this.host, () => {
      this.platform.log.debug('Connected to the spa');
      this.isOnline = true;
    });
  }

  private teardownSocket() {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.destroy();
      this.client = undefined;
    }
  }

  private scheduleReconnect() {
    this.isOnline = false;
    this.teardownSocket();
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 5000);
  }

  private startSendingRefreshCommand() {
    setInterval(() => {
      this.sendRefreshCommand();
    }, 5000); // 5 seconds interval
  }

  private async sendRefreshCommand() {
    if (!this.isOnline) {
      return;
    }
    try {
      // The official app sends a { sid: ..., type: 0, data: "" } heartbeat message every 50 seconds
      // but the response to the heartbeat does not return a device state.
      await this.postMessage({
        type: 1,
        data: '8888060FEE0F01DA', // Refresh command
      });
    } catch (error) {
      // ignore
    }
  }

  private onData(data: Buffer) {
    const stringMessage = data.toString();

    this.platform.log.debug('Received message:', stringMessage);

    const message = JSON.parse(stringMessage) as Message;
    const { sid } = message;
    if (this.messageQueue.has(sid)) {
      const { resolve, reject, timeout } = this.messageQueue.get(sid)!;
      clearTimeout(timeout);

      if (message.result === 'ok') {
        resolve(message);
        this.parseDeviceState(message.data);
      } else {
        this.platform.log.error(`Response result not ok: ${JSON.stringify(message)}`);
        reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }
      this.messageQueue.delete(sid);
    }
  }

  private onError(err: Error) {
    this.platform.log.warn('Socket error:', err.message, '. Attempting to reconnect in 5000 ms');
    this.scheduleReconnect();
  }

  private onClose() {
    this.platform.log.warn('Connection closed, attempting to reconnect in 5000 ms');
    this.scheduleReconnect();
  }

  private async postMessage(message: { type: number; data: string }): Promise<Message> {
    return new Promise((resolve, reject) => {
      const sid = `${Date.now()}`;
      const timeout = setTimeout(() => {
        if (this.messageQueue.has(sid)) {
          this.messageQueue.delete(sid);
          this.platform.log.error('Response timeout');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.OPERATION_TIMED_OUT));
        }
      }, 10000); // 10 seconds timeout

      this.messageQueue.set(sid, { resolve, reject, timeout });

      const stringMessage = JSON.stringify({
        sid: sid,
        type: message.type,
        data: message.data,
      });

      // Extra space added on purpose to line up sent and received messages in logs
      this.platform.log.debug('Sending message: ', stringMessage);

      this.client?.write(stringMessage);
    });
  }

  private parseDeviceState(data: string) {
    if (!data.startsWith('FFFF')) {
      return;
    }

    const buffer = Buffer.from(data, 'hex');
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

    this.filterService.updateCharacteristic(this.platform.Characteristic.On, this.deviceState.isFilterOn);
    this.bubblesService.updateCharacteristic(this.platform.Characteristic.On, this.deviceState.isBubblesOn);
    this.controllerService?.updateCharacteristic(this.platform.Characteristic.On, this.deviceState.isControllerOn);
    this.waterJetService?.updateCharacteristic(this.platform.Characteristic.On, this.deviceState.isWaterJetOn);
    this.sanitizerService?.updateCharacteristic(this.platform.Characteristic.On, this.deviceState.isSanitizerOn);
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      this.deviceState.isHeaterOn ?
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT :
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      this.deviceState.isHeaterOn ?
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

    const value = this.deviceState.isHeaterOn;

    this.platform.log.debug('Thermostat Get Characteristic CurrentHeatingCoolingState ->', value);

    return value ?
      this.platform.Characteristic.CurrentHeatingCoolingState.HEAT :
      this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
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
        await this.setFilterOn(true);
      }

      await this.postMessage({
        type: 1,
        data: '8888060F010010C8', // HeatOnOff command
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

    const value = this.deviceState.isHeaterOn;

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
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isFilterOn) {
      // Ensure heater is disabled before disabling the heater
      if (!value && this.deviceState.isHeaterOn) {
        await this.setTargetHeatingCoolingState(this.platform.Characteristic.TargetHeatingCoolingState.OFF);
      }

      await this.postMessage({
        type: 1,
        data: '8888060F010004D4', // FilterOnOff command
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

    const value = this.deviceState.isFilterOn;

    this.platform.log.debug('Filter Get Characteristic On ->', value);

    return value;
  }

  async setBubblesOn(value: CharacteristicValue) {
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isBubblesOn) {
      await this.postMessage({
        type: 1,
        data: '8888060F010400D4', // BubbleOnOff command
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
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isControllerOn) {
      await this.postMessage({
        type: 1,
        data: '8888060F01400098', // PowerOnOff command
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
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isWaterJetOn) {
      await this.postMessage({
        type: 1,
        data: '8888060F011000C8', // JetOnOff command
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
    if (!this.isOnline) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.deviceState) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    if (value as boolean !== this.deviceState.isSanitizerOn) {
      await this.postMessage({
        type: 1,
        data: '8888060F010001D7', // SanitizerOnOff command
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
