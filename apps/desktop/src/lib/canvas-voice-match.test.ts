import { expect, it } from 'vitest'

import { matchCanvasVoiceCommand } from './canvas-voice-match'

it.each([
  ['Сиэль, проверь файл', 'ciel', 'проверь файл'],
  ['CL hello', 'ciel', 'hello'],
  ['Ciel', 'ciel', ''],
  ['эй Кай: задачу', 'kai', 'задачу'],
  ['Ren do it', 'ren', 'do it'],
  ['Мио!', 'mio', ''],
  ['Юки привет', 'yuki', 'привет'],
  ['hey Yuki hello', 'yuki', 'hello']
])('recognizes only an explicit prefix: %s', (text, id, suffix) => {
  expect(matchCanvasVoiceCommand(text)).toEqual({ id, text: suffix })
})
it.each(['', 'привет Кай', 'рендер файла', 'Kairos', 'мы говорим про Юки', 'до свидания'])(
  'drops ambient text: %s',
  text => {
    expect(matchCanvasVoiceCommand(text)).toBeNull()
  }
)
