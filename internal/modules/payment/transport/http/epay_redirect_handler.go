package paymenthttp

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"html/template"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	paymentdomain "github.com/dujiao-next/internal/modules/payment/domain"

	"github.com/dujiao-next/internal/constants"
	"github.com/dujiao-next/internal/shared/jsonmap"

	"github.com/gin-gonic/gin"
)

// EpayRedirectPaymentLookup 只读取渲染易支付跳转表单所需的支付记录。
type EpayRedirectPaymentLookup interface {
	GetByID(id uint) (*paymentdomain.Payment, error)
}

// EpayRedirectHandler 把已保存的 v2 跳转参数渲染成自动提交的 POST 表单。
type EpayRedirectHandler struct {
	payments EpayRedirectPaymentLookup
}

func NewEpayRedirectHandler(payments EpayRedirectPaymentLookup) *EpayRedirectHandler {
	if payments == nil {
		panic("epay redirect handler: payments is nil")
	}
	return &EpayRedirectHandler{payments: payments}
}

type epayRedirectView struct {
	Action string
	Fields []epayRedirectField
}

type epayRedirectField struct {
	Name  string
	Value string
}

var epayRedirectTemplate = template.Must(template.New("epay-redirect").Parse(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<form method="post" action="{{.Action}}">
{{- range .Fields}}
<input type="hidden" name="{{.Name}}" value="{{.Value}}">
{{- end}}
<input type="submit">
</form>
<script>document.forms[0].submit()</script>
</body>
</html>`))

// EpayRedirect 渲染自动提交的 POST 表单。不匹配的请求返回 404，且不包含表单。
func (h *EpayRedirectHandler) EpayRedirect(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	paymentID, token, ok := epayRedirectQuery(c)
	if !ok {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	payment, err := h.payments.GetByID(paymentID)
	if err != nil || !epayRedirectPayable(payment, time.Now()) {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	action, fields, accepted := epayRedirectForm(payment.ProviderPayload, token)
	if !accepted {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	var body bytes.Buffer
	if err := epayRedirectTemplate.Execute(&body, epayRedirectView{Action: action, Fields: fields}); err != nil {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", body.Bytes())
}

func epayRedirectQuery(c *gin.Context) (uint, string, bool) {
	rawID := strings.TrimSpace(c.Query("payment_id"))
	token := strings.TrimSpace(c.Query("token"))
	parsed, err := strconv.ParseUint(rawID, 10, 64)
	if err != nil || parsed == 0 || token == "" || uint64(uint(parsed)) != parsed {
		return 0, "", false
	}
	return uint(parsed), token, true
}

func epayRedirectPayable(payment *paymentdomain.Payment, now time.Time) bool {
	if payment == nil {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(payment.ProviderType), constants.PaymentProviderEpay) {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(payment.InteractionMode), constants.PaymentInteractionRedirect) {
		return false
	}
	if payment.Status != constants.PaymentStatusPending {
		return false
	}
	if payment.ExpiredAt != nil && !payment.ExpiredAt.After(now) {
		return false
	}
	if payment.SupersededAt != nil || payment.SupersededByPaymentID != nil {
		return false
	}
	return true
}

func epayRedirectForm(payload jsonmap.JSON, providedToken string) (string, []epayRedirectField, bool) {
	if payload == nil {
		return "", nil, false
	}
	method, _ := payload["submit_method"].(string)
	if !strings.EqualFold(strings.TrimSpace(method), http.MethodPost) {
		return "", nil, false
	}
	storedToken, _ := payload["token"].(string)
	if !epayRedirectTokenMatch(storedToken, providedToken) {
		return "", nil, false
	}
	endpoint, _ := payload["endpoint"].(string)
	endpoint = strings.TrimSpace(endpoint)
	if !httpEndpoint(endpoint) {
		return "", nil, false
	}
	params, ok := epayRedirectParams(payload["params"])
	if !ok {
		return "", nil, false
	}
	keys := make([]string, 0, len(params))
	for key, value := range params {
		if strings.TrimSpace(key) == "" || strings.TrimSpace(value) == "" {
			continue
		}
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		return "", nil, false
	}
	sort.Strings(keys)
	fields := make([]epayRedirectField, 0, len(keys))
	for _, key := range keys {
		fields = append(fields, epayRedirectField{Name: key, Value: params[key]})
	}
	return endpoint, fields, true
}

func epayRedirectParams(raw interface{}) (map[string]string, bool) {
	params, ok := raw.(map[string]interface{})
	if !ok {
		return nil, false
	}
	out := make(map[string]string, len(params))
	for key, value := range params {
		text, ok := value.(string)
		if !ok {
			return nil, false
		}
		out[key] = text
	}
	return out, true
}

func httpEndpoint(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Host != ""
}

func epayRedirectTokenMatch(stored, provided string) bool {
	if stored == "" || provided == "" {
		return false
	}
	sumStored := sha256.Sum256([]byte(stored))
	sumProvided := sha256.Sum256([]byte(provided))
	return subtle.ConstantTimeCompare(sumStored[:], sumProvided[:]) == 1
}
