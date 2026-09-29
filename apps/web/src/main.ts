import '@fontsource/caveat/latin-400.css'
import '@fontsource/caveat/latin-700.css'
import { createApp } from 'vue'
import App from './App.vue'
import { boot } from './app'
import { router } from './router'
import { diagnostics, installGlobalErrorHandlers } from './services/diagnostics'
import { whenFontsReady } from './services/fonts'
import { initPwa } from './services/pwa'
import './styles.css'

installGlobalErrorHandlers()

const app = createApp(App)
app.config.errorHandler = (err, _inst, info) => diagnostics.log(`vue.${info}`, err)
app.use(router)
app.mount('#app')

void boot()
initPwa()
void whenFontsReady()
