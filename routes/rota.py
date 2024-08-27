# routes/rota.py
from flask import Blueprint, render_template
from models import Person, Shift

rota_bp = Blueprint('rota', __name__, url_prefix='/rota')

@rota_bp.route('/rota_request', methods=['GET'], endpoint='rota_request')
def rota_request():
    active_people = Person.query.filter_by(activated=True).order_by(Person.name).all()
    available_shifts = Shift.query.order_by(Shift.name).all()
    return render_template('rota_request.html', active_people=active_people, available_shifts=available_shifts)