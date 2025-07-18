# Homebridge Intex SPA plugin WIP v0.1

any changes are updated in homebridge with a 1 min delay

if you do some action first on the panel then on homekit it would be reverted as intex api only supports toggling on/off; it do not have a separate actions for on and off like any reasonable api would(!)

discoverability:
in theory SPAs could be discovered by broadcasting "spa_request" on 255.255.255.255:10549 but i couldnt make it work

device data (might be used to control the visibility of bubbles, filter, water jet, sanitizer):
send: {"data":"","sid":"1654467840319","type":3}
receive: {"sid":"1654467840319","data":"{\"ip\":\"192.168.x.x\",\"uid\":\"0K040210272020102000008062\",\"dtype\":\"spa\"}","result":"ok","type":3}

#

Go check out my other Homebridge plugins:

* [homebridge-futurehome](https://github.com/adrianjagielak/homebridge-futurehome) ([npm](https://npmjs.com/package/homebridge-futurehome))
* [homebridge-tuya-plus](https://github.com/adrianjagielak/homebridge-tuya-plus) ([npm](https://npmjs.com/package/homebridge-tuya-plus))
* [homebridge-eqiva-swift-bridge](https://github.com/adrianjagielak/eqiva-smart-lock-bridge) ([npm](https://npmjs.com/package/homebridge-eqiva-swift-bridge))
* [homebridge-intex-plus](https://github.com/adrianjagielak/homebridge-intex-plus) ([npm](https://npmjs.com/package/homebridge-intex-plus))
* [homebridge-simple-router-status](https://github.com/adrianjagielak/homebridge-simple-router-status) ([npm](https://npmjs.com/package/homebridge-simple-router-status))
