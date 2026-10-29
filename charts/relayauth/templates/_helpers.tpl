{{- define "relayauth.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "relayauth.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "relayauth.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "relayauth.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "relayauth.selectorLabels" -}}
app.kubernetes.io/name: {{ include "relayauth.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "relayauth.claimName" -}}
{{- default (printf "%s-data" (include "relayauth.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{- /*
Public URL of this RelayAuth. Defaults to the release's own Service in-cluster
(http://<fullname>.<namespace>.svc:<service.port>) so any release name resolves.
*/}}
{{- define "relayauth.baseUrl" -}}
{{- if .Values.baseUrl }}
{{- .Values.baseUrl }}
{{- else }}
{{- printf "http://%s.%s.svc:%v" (include "relayauth.fullname" .) .Release.Namespace .Values.service.port }}
{{- end }}
{{- end }}

{{- define "relayauth.issuer" -}}
{{- default (include "relayauth.baseUrl" .) .Values.issuer }}
{{- end }}
