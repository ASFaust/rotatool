# routes/rota.py
from flask import Blueprint, render_template

rota_bp = Blueprint('rota', __name__, url_prefix='/rota')

@rota_bp.route('/rota_request', methods=['GET'], endpoint='rota_request')
def rota_request():
    return render_template('rota_request.html')