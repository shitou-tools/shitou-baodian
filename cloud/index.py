"""FC 3.0 built-in Python 3.10/3.12 handler. Standard library only.

The function role supplies temporary OSS credentials. BACKUP_TOKEN is an
independent client secret. Neither secret is included in responses or logs.
"""
import base64
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import quote, unquote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
import xml.etree.ElementTree as ET

BUCKET = os.environ.get('OSS_BUCKET', '')
REGION = os.environ.get('OSS_REGION', '')
PREFIX = 'prompt-box-backups/v1/'
MAX_BYTES = 9 * 1024 * 1024
KEY_RE = re.compile(r'^' + re.escape(PREFIX) + r'\d{13}-[a-f0-9-]{36}-[a-f0-9-]{36}\.json$')


class CloudError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def signed_headers(method, key, query, headers, credentials, timestamp=None,
                   bucket=BUCKET, region=REGION, additional=''):
    """OSS V4; required headers + explicitly listed additional headers."""
    timestamp = timestamp or datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    headers = {k.lower(): str(v).strip() for k, v in headers.items()}
    headers.update({'x-oss-date': timestamp, 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD'})
    if credentials[2]:
        headers['x-oss-security-token'] = credentials[2]
    encoded_query = sorted((quote(str(k), safe=''), quote(str(v), safe='')) for k, v in query.items())
    query_text = '&'.join(k + ('=' + v if v else '') for k, v in encoded_query)
    additional_names = sorted(filter(None, additional.split(';')))
    canonical_headers = ''.join(k + ':' + headers[k] + '\n' for k in sorted(headers)
                                if k.startswith('x-oss-') or k in ('content-md5', 'content-type') or k in additional_names)
    canonical = '\n'.join([method, quote('/' + bucket + '/' + key, safe='/'), query_text,
                            canonical_headers, ';'.join(additional_names), 'UNSIGNED-PAYLOAD'])
    scope = f'{timestamp[:8]}/{region}/oss/aliyun_v4_request'
    to_sign = '\n'.join(['OSS4-HMAC-SHA256', timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signing_key = ('aliyun_v4' + credentials[1]).encode()
    for value in (timestamp[:8], region, 'oss', 'aliyun_v4_request'):
        signing_key = hmac.new(signing_key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
    optional = ',AdditionalHeaders=' + ';'.join(additional_names) if additional_names else ''
    headers['authorization'] = f'OSS4-HMAC-SHA256 Credential={credentials[0]}/{scope}{optional},Signature={signature}'
    return headers, query_text


def credentials_for(context):
    c = getattr(context, 'credentials', None)
    result = ((c.access_key_id, c.access_key_secret, c.security_token) if c else
              tuple(os.environ.get(k, '') for k in ('ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN')))
    if not all(result):
        raise CloudError('CONFIG', 503)
    return result


def oss(method, key, credentials, query=None, data=None):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', BUCKET) or not re.fullmatch(r'[a-z0-9-]+', REGION):
        raise CloudError('CONFIG', 503)
    headers = {}
    if data is not None:
        headers = {'content-type': 'application/json; charset=utf-8',
                   'content-md5': base64.b64encode(hashlib.md5(data).digest()).decode(),
                   'x-oss-forbid-overwrite': 'true'}
    headers, query_text = signed_headers(method, key, query or {}, headers, credentials)
    url = f'https://{BUCKET}.oss-{REGION}.aliyuncs.com/' + quote(key, safe='/')
    if query_text:
        url += '?' + query_text
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with build_opener(NoRedirect()).open(req, timeout=15) as response:
            result = response.read(MAX_BYTES + 1)
            if len(result) > MAX_BYTES:
                raise CloudError('INVALID', 413)
            return result
    except HTTPError as e:
        if e.code == 403 and method == 'DELETE':
            raise CloudError('DELETE_PERMISSION', 403) from None
        if e.code == 404:
            raise CloudError('NOT_FOUND', 404) from None
        if e.code == 409:
            raise CloudError('CONFLICT', 409) from None
        raise CloudError('OSS', 502) from None


def list_backups(credentials, marker='', limit=50):
    if not isinstance(marker, str) or (marker and (not marker.startswith(PREFIX) or len(marker) > 512)):
        raise CloudError('INVALID')
    xml = oss('GET', '', credentials, {'prefix': PREFIX, 'max-keys': str(limit), 'marker': marker, 'encoding-type': 'url'})
    root = ET.fromstring(xml)
    # OSS normally omits namespaces; accepting them makes fixtures and APIs consistent.
    for node in root.iter():
        node.tag = node.tag.split('}')[-1]
    items = []
    for node in root.findall('Contents'):
        key = unquote(node.findtext('Key', ''))
        if KEY_RE.fullmatch(key):
            items.append({'key': key, 'lastModified': node.findtext('LastModified'), 'size': int(node.findtext('Size', '0'))})
    next_marker = unquote(root.findtext('NextMarker', '')) if root.findtext('IsTruncated') == 'true' else ''
    if next_marker and (not next_marker.startswith(PREFIX) or len(next_marker) > 512):
        raise CloudError('INVALID')
    return {'items': items, 'nextMarker': next_marker, 'canDelete': True}


def process(body, credentials):
    action = body.get('action')
    if action == 'health':
        oss('GET', '', credentials, {'prefix': PREFIX, 'max-keys': '1'})
        return {'bucket': BUCKET, 'region': REGION, 'prefix': PREFIX}
    if action == 'list':
        return list_backups(credentials, body.get('marker', ''))
    key = body.get('key', '')
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise CloudError('INVALID')
    if action == 'delete':
        if body.get('confirmed') is not True:
            raise CloudError('INVALID')
        # OSS DeleteObject is idempotent; never accepts directories or arbitrary keys.
        oss('DELETE', key, credentials)
        return {'key': key, 'deleted': True}
    if action == 'get':
        data = oss('GET', key, credentials)
        return {'raw': data.decode('utf-8'), 'sha256': hashlib.sha256(data).hexdigest()}
    if action == 'put':
        raw = body.get('raw')
        if not isinstance(raw, str):
            raise CloudError('INVALID')
        data = raw.encode('utf-8')
        if len(data) > MAX_BYTES:
            raise CloudError('INVALID', 413)
        backup = json.loads(raw)
        if not isinstance(backup, dict) or backup.get('app') != 'prompt-library' or backup.get('version') != 2 or any(not isinstance(backup.get(k), list) for k in ('prompts', 'categories', 'drafts')):
            raise CloudError('INVALID')
        try:
            oss('PUT', key, credentials, data=data)
        except CloudError as error:
            if error.code != 'CONFLICT':
                raise
            # A timed-out upload may have succeeded; identical retries are safe.
            if oss('GET', key, credentials) != data:
                raise
        return {'key': key, 'sha256': hashlib.sha256(data).hexdigest()}
    raise CloudError('INVALID')


def reply(status, data):
    return {'statusCode': status, 'headers': {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
            'isBase64Encoded': False, 'body': json.dumps(data, ensure_ascii=False, separators=(',', ':'))}


def handler(event, context):
    try:
        token = os.environ.get('BACKUP_TOKEN', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', token):
            raise CloudError('CONFIG', 503)
        if isinstance(event, (bytes, str)):
            if len(event) > 3 * MAX_BYTES:
                raise CloudError('INVALID', 413)
            event = json.loads(event)
        headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
        if not hmac.compare_digest(str(headers.get('authorization', '')).encode(), ('Bearer ' + token).encode()):
            raise CloudError('AUTH', 401)
        if event.get('requestContext', {}).get('http', {}).get('method') != 'POST':
            raise CloudError('INVALID', 405)
        raw = event.get('body', '')
        if event.get('isBase64Encoded'):
            raw = base64.b64decode(raw, validate=True)
        if len(raw) > 2 * MAX_BYTES + 65536:
            raise CloudError('INVALID', 413)
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise CloudError('INVALID')
        result = process(body, credentials_for(context))
        return reply(200, {'ok': True, **result})
    except CloudError as e:
        return reply(e.status, {'ok': False, 'code': e.code})
    except (ValueError, TypeError, AttributeError, KeyError):
        return reply(400, {'ok': False, 'code': 'INVALID'})
    except Exception:
        return reply(502, {'ok': False, 'code': 'OSS'})
