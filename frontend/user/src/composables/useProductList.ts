import { computed, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { productAPI, categoryAPI } from '../api'
import { buildCategoryGroups, createCategoryMap, normalizeCategoryParentId, type PublicCategory } from '../utils/category'
import { debounceAsync } from '../utils/debounce'
import { resetListScrollSignal, resolveListScrollSignal } from '../utils/listScrollSignal'

export interface UseProductListOptions {
  pageSize?: number
  homeRouteName?: string
  categoryRouteName?: string
}

export function useProductList(options: UseProductListOptions = {}) {
  const {
    pageSize: defaultPageSize = 20,
    homeRouteName = 'home',
    categoryRouteName = 'category-products',
  } = options

  const router = useRouter()
  const route = useRoute()

  const loading = ref(true)
  const products = ref<any[]>([])
  const categories = ref<PublicCategory[]>([])
  const selectedCategory = ref<number | null>(null)
  const searchQuery = ref('')
  const currentPage = ref(1)
  const pageSize = ref(defaultPageSize)
  const totalPages = ref(0)
  const showFilterDrawer = ref(false)
  const expandedParentIds = ref<number[]>([])

  const categoryGroups = computed(() => buildCategoryGroups(categories.value))
  const categoryMap = computed(() => createCategoryMap(categories.value))

  let initializing = true

  const isParentExpanded = (categoryId: number) => {
    return expandedParentIds.value.includes(categoryId)
  }

  const expandParentCategory = (categoryId: number) => {
    if (!categoryId || isParentExpanded(categoryId)) return
    expandedParentIds.value = [...expandedParentIds.value, categoryId]
  }

  const toggleParentCategory = (categoryId: number) => {
    if (isParentExpanded(categoryId)) {
      expandedParentIds.value = expandedParentIds.value.filter((id) => id !== categoryId)
      return
    }
    expandParentCategory(categoryId)
  }

  const getParentToggleButtonClass = (categoryId: number) => {
    return isParentExpanded(categoryId)
      ? 'bg-primary text-primary-foreground border-transparent'
      : 'bg-card/70 text-muted-foreground hover:text-foreground'
  }

  const syncExpandedCategoryState = () => {
    if (!selectedCategory.value) return

    const matched = categoryMap.value.get(selectedCategory.value)
    if (!matched) return

    const parentId = normalizeCategoryParentId(matched.parent_id)
    if (parentId > 0) {
      expandParentCategory(parentId)
      return
    }

    const selectedGroup = categoryGroups.value.find((group) => group.id === matched.id)
    if (selectedGroup?.children.length) {
      expandParentCategory(selectedGroup.id)
    }
  }

  const selectCategory = (categoryId: number | null, closeDrawer = false) => {
    selectedCategory.value = categoryId
    if (closeDrawer) {
      showFilterDrawer.value = false
    }
  }

  /**
   * 将分页/搜索状态统一写入 URL query，避免多个写入点互相覆盖。
   * 切分类时通过 router.replace({ name, params }) 跳转，那里不带 query，
   * 页码会自然归 1，不需要在这里处理。
   * page=1 时不带参数，保持 URL 简洁。
   */
  const syncQuery = () => {
    const query: Record<string, string> = { ...route.query as Record<string, string> }
    if (currentPage.value > 1) {
      query.page = String(currentPage.value)
    } else {
      delete query.page
    }
    router.replace({ query })
  }

  const loadProducts = async () => {
    loading.value = true
    resetListScrollSignal()
    try {
      const params: any = {
        page: currentPage.value,
        page_size: pageSize.value,
      }
      if (selectedCategory.value) {
        params.category_id = selectedCategory.value
      }
      const keyword = searchQuery.value.trim()
      if (keyword) {
        params.search = keyword
      }
      const response = await productAPI.list(params)
      products.value = response.data.data || []
      if (response.data.pagination) {
        totalPages.value = response.data.pagination.total_page || 0
      }
      // 页码超出范围时回落到末页并重新加载
      if (totalPages.value > 0 && currentPage.value > totalPages.value) {
        currentPage.value = totalPages.value
        syncQuery()
        await loadProducts()
        return
      }
    } catch (error) {
      console.error('Failed to load products:', error)
    } finally {
      loading.value = false
      resolveListScrollSignal()
    }
  }

  const loadCategories = async () => {
    try {
      const response = await categoryAPI.list()
      categories.value = response.data.data || []
    } catch (error) {
      console.error('Failed to load categories:', error)
    }
  }

  const debouncedLoadProducts = debounceAsync(loadProducts, 300)

  const changePage = (page: number) => {
    if (page < 1 || page > totalPages.value) return
    currentPage.value = page
    // URL 更新后由 watch(route.query.page) 触发加载，避免双重请求
    syncQuery()
  }

  const clearSearch = () => {
    if (!searchQuery.value) return
    searchQuery.value = ''
    currentPage.value = 1
    syncQuery()
    debouncedLoadProducts()
  }

  const onSearch = () => {
    currentPage.value = 1
    syncQuery()
    debouncedLoadProducts()
  }

  const syncSelectedCategoryFromRoute = () => {
    if (route.name !== categoryRouteName) {
      if (selectedCategory.value !== null) {
        selectedCategory.value = null
      }
      return false
    }

    const slugParam = route.params.slug as string | undefined
    if (!slugParam || categories.value.length === 0) return false

    const matched = categories.value.find((category) => category.slug === slugParam)
    if (!matched) return false

    if (selectedCategory.value !== matched.id) {
      selectedCategory.value = matched.id
    }

    return true
  }

  /** 从 URL query.page 读取页码，非法值回落到 1 */
  const readPageFromQuery = (): number => {
    const raw = route.query.page
    const parsed = parseInt(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''), 10)
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
  }

  watch(selectedCategory, () => {
    if (initializing) return
    currentPage.value = 1
    syncExpandedCategoryState()
    debouncedLoadProducts()

    if (selectedCategory.value) {
      const matched = categories.value.find((category) => category.id === selectedCategory.value)
      if (matched?.slug && route.params.slug !== matched.slug) {
        // 切分类时不保留 page query，让 URL 简洁
        router.replace({ name: categoryRouteName, params: { slug: matched.slug } })
      }
    } else if (route.name === categoryRouteName) {
      router.replace({ name: homeRouteName })
    }
  })

  watch(searchQuery, () => {
    if (initializing) return
    currentPage.value = 1
    syncQuery()
    debouncedLoadProducts()
  })

  watch(
    () => route.params.slug,
    () => {
      if (initializing) return
      if (categories.value.length === 0) return
      syncSelectedCategoryFromRoute()
    },
  )

  // URL 里的 page 变化时（包括浏览器后退/前进）同步状态并加载
  watch(
    () => route.query.page,
    () => {
      if (initializing) return
      const page = readPageFromQuery()
      if (page === currentPage.value) return
      currentPage.value = page
      debouncedLoadProducts()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    },
  )

  const initialize = async () => {
    await loadCategories()
    if (syncSelectedCategoryFromRoute()) {
      syncExpandedCategoryState()
    }
    // 初始化时从 URL 恢复页码
    currentPage.value = readPageFromQuery()
    await loadProducts()
    initializing = false
  }

  const cleanup = () => {
    debouncedLoadProducts.cancel()
  }

  return {
    loading,
    products,
    categories,
    selectedCategory,
    searchQuery,
    currentPage,
    pageSize,
    totalPages,
    showFilterDrawer,
    expandedParentIds,
    categoryGroups,
    categoryMap,
    isParentExpanded,
    toggleParentCategory,
    getParentToggleButtonClass,
    selectCategory,
    loadProducts,
    loadCategories,
    changePage,
    clearSearch,
    onSearch,
    syncSelectedCategoryFromRoute,
    syncExpandedCategoryState,
    initialize,
    cleanup,
  }
}
