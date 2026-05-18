const env = require('./config/env')
const app = require('./app')

app.listen(env.PORT, () => {
  console.log(`OSCT backend listening on http://localhost:${env.PORT}`)
  console.log(`CORS origin: ${env.CLIENT_URL}`)
})
