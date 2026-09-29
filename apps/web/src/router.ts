import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'library', component: () => import('./views/LibraryView.vue') },
    { path: '/n/:id', name: 'notebook', component: () => import('./views/NotebookView.vue'), props: true },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
