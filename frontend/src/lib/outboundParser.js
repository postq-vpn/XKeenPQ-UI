const safeBase64 = (str) =>
  atob(
    str
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(str.length + ((4 - (str.length % 4)) % 4), '=')
  )

const getStreamSettings = (type, params) => {
  const number = (val) => (val ? +val : undefined)
  const bool = (val) => val === 'true' || val === true || val === '1' || undefined
  const string = (val) => val || undefined
  let finalmask
  try {
    finalmask = params.fm ? JSON.parse(decodeURIComponent(params.fm)) : undefined
  } catch {}
  const output = {
    network: type,
    security: string(params.security),
    tlsSettings:
      params.security === 'tls'
        ? {
            fingerprint: string(params.fp) || 'chrome',
            serverName: string(params.sni),
            alpn: params.alpn?.split(','),
            allowInsecure: bool(params.allowinsecure || params.insecure),
          }
        : undefined,
    realitySettings:
      params.security === 'reality'
        ? {
            fingerprint: string(params.fp) || 'chrome',
            serverName: string(params.sni),
            publicKey: string(params.pbk),
            shortId: string(params.sid),
            spiderX: string(params.spx),
            mldsa65Verify: string(params.pqv),
          }
        : undefined,
    finalmask,
  }
  if (type === 'tcp' && params.headerType) output.tcpSettings = { header: { type: params.headerType } }
  if (type === 'raw' && params.headerType) output.rawSettings = { header: { type: params.headerType } }
  if (type === 'xhttp') {
    let extra
    try {
      extra = params.extra ? JSON.parse(decodeURIComponent(params.extra)) : undefined
    } catch {}
    output.xhttpSettings = {
      host: string(params.host),
      path: params.path || '/',
      mode: params.mode || 'auto',
      extra,
    }
  }
  if (type === 'kcp')
    output.kcpSettings = {
      mtu: number(params.mtu),
      tti: number(params.tti),
      uplinkCapacity: number(params.uplinkCapacity),
      downlinkCapacity: number(params.downlinkCapacity),
      congestion: bool(params.congestion),
      readBufferSize: number(params.readBufferSize),
      writeBufferSize: number(params.writeBufferSize),
      header: params.headerType ? { type: params.headerType } : undefined,
      seed: string(params.seed),
    }
  if (type === 'grpc')
    output.grpcSettings = {
      serviceName: string(params.servicename || params.path),
      authority: string(params.authority),
      multiMode: params.mode === 'multi',
      user_agent: string(params.user_agent),
      idle_timeout: number(params.idle_timeout),
      health_check_timeout: number(params.health_check_timeout),
      permit_without_stream: bool(params.permit_without_stream),
      initial_windows_size: number(params.initial_windows_size),
    }
  if (type === 'ws')
    output.wsSettings = {
      path: params.path || '/',
      host: string(params.host),
      heartbeatPeriod: number(params.heartbeatPeriod),
    }
  if (type === 'httpupgrade')
    output.httpupgradeSettings = {
      path: params.path || '/',
      host: string(params.host),
    }
  return output
}

const parseUrl = (uri, protocol, settingsMapper) => {
  const url = new URL(uri)
  const params = Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]))
  const baseConfig = {
    tag: decodeURIComponent(url.hash.slice(1)) || 'PROXY',
    protocol: protocol,
    settings: settingsMapper(url, params),
  }

  if (!['shadowsocks', 'hysteria2'].includes(protocol)) {
    baseConfig.streamSettings = getStreamSettings(params.type || 'tcp', {
      ...params,
      sni: params.sni,
    })
  }

  return baseConfig
}

const protocols = {
  vless: (uri) =>
    parseUrl(uri, 'vless', (url, params) => ({
      address: url.hostname,
      port: +url.port || 443,
      id: url.username,
      encryption: params.encryption || 'none',
      flow: params.flow || undefined,
    })),

  trojan: (uri) =>
    parseUrl(uri, 'trojan', (url) => ({
      address: url.hostname,
      port: +url.port || 443,
      password: url.username,
    })),

  hysteria2: (uri) =>
    parseUrl(uri, 'hysteria2', (url, params) => ({
      address: url.hostname,
      port: +url.port || 443,
      password: decodeURIComponent(url.password ? `${url.username}:${url.password}` : url.username),
      sni: params.sni,
      insecure: params.insecure === '1' || params.allowInsecure === '1',
      obfs: params.obfs,
      obfsPassword: params['obfs-password'],
      fingerprint: params.fp || params.fingerprint,
      alpn: params.alpn?.split(','),
      up: params.up,
      down: params.down,
    })),

  ss: (uri) => {
    let [head, tag] = uri.split('#')
    head = head.split('?')[0].replace('ss://', '')

    try {
      tag = tag ? decodeURIComponent(tag) : 'PROXY'
    } catch {
      tag = tag || 'PROXY'
    }

    let method, password, address, port
    if (head.includes('@')) {
      const [userinfo, server] = head.split('@')
      const decoded = safeBase64(userinfo).split(':')
      method = decoded[0]
      password = decoded.slice(1).join(':')
      ;[address, port] = server.split(':')
      if (address.startsWith('[') && server.includes(']:')) {
        const parts = server.split(']:')
        address = parts[0] + ']'
        port = parts[1]
      }
    } else {
      const decoded = safeBase64(head)
      const match = decoded.match(/^(.*?):(.*?)@(.*):(\d+)$/)
      if (!match) throw new Error('Ошибка парсинга')
      ;[, method, password, address, port] = match
    }

    return {
      tag,
      protocol: 'shadowsocks',
      settings: {
        address,
        port: +port,
        method,
        password,
      },
    }
  },

  vmess: (uri) => {
    const data = JSON.parse(safeBase64(uri.slice(8)))
    if (data.tls === 'tls') {
      data.security = 'tls'
      data.sni = data.sni || data.host
    }
    return {
      tag: data.ps || 'PROXY',
      protocol: 'vmess',
      settings: {
        address: data.add,
        port: +data.port,
        id: data.id,
        alterId: +data.aid || 0,
        security: data.scy || 'auto',
      },
      streamSettings: getStreamSettings(data.net || 'tcp', data),
    }
  },
}

function parseProxyUri(uri) {
  const protocol = uri.split(':')[0].replace('hy2', 'hysteria2')
  if (!protocols[protocol]) throw new Error('Неизвестная ссылка')
  return protocols[protocol](uri)
}

const parseHysteria2Xray = (uri) => {
  const url = new URL(uri)
  const params = Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]))
  const tag = decodeURIComponent(url.hash.slice(1)) || 'PROXY'

  const streamSettings = getStreamSettings('hysteria', { ...params, security: params.security || 'tls' })
  streamSettings.hysteriaSettings = {
    auth: decodeURIComponent(url.password ? `${url.username}:${url.password}` : url.username),
    version: 2,
  }
  if (streamSettings.tlsSettings) streamSettings.tlsSettings.alpn = streamSettings.tlsSettings.alpn || ['h3']
  streamSettings.finalmask = {
    ...streamSettings.finalmask,
    quicParams: { congestion: 'bbr', bbrProfile: 'standard', ...streamSettings.finalmask?.quicParams },
  }

  return {
    tag,
    protocol: 'hysteria',
    settings: {
      address: url.hostname,
      port: +url.port || 443,
      version: 2,
    },
    streamSettings,
  }
}

function generateOutbound(uri, existingConfig = '') {
  const generateName = (base) => {
    let index = 1
    while (existingConfig.includes(`${base}_${index}`)) index++
    return `${base}_${index}`
  }

  if (uri.startsWith('http')) throw new Error('Подписки добавляются через раздел подписок Xray')
  if (uri.startsWith('hysteria2') || uri.startsWith('hy2')) {
    const config = parseHysteria2Xray(uri)
    if (config.tag === 'PROXY' || existingConfig.includes(config.tag)) config.tag = generateName('hysteria')
    return { type: 'outbound', content: JSON.stringify(config, null, 2) }
  }

  const config = parseProxyUri(uri)
  if (config.tag === 'PROXY' || existingConfig.includes(config.tag)) config.tag = generateName(config.protocol)

  return { type: 'outbound', content: JSON.stringify(config, null, 2) }
}

window.generateOutbound = generateOutbound
